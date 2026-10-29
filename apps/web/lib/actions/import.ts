'use server';

import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getSession } from '../session';
import { withTenant, asAdmin } from '../db';
import { parseCsvBuffer } from '@rros/domain/import/parse';
import { detectMapping, isMappingUsable, type Mapping, type TargetField } from '@rros/domain/import/detect';
import { importPipeline } from '@rros/domain/import/pipeline';
import { assignArm, commitImport, loadExisting } from '@rros/db/imports';
import { assertEntitlement, recordFunnel } from '@rros/db/billing';
import { patchOnboardingState } from '@rros/db/onboarding';

const MAX_BYTES = 5 * 1024 * 1024;

export interface UploadState {
  error?: string;
}

/** Step 1 — receive the file, parse it, stage the rows, go to mapping. */
export async function uploadAction(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const session = await getSession();
  if (!session) return { error: 'session' };

  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'no_file' };
  if (file.size === 0) return { error: 'empty_file' };
  if (file.size > MAX_BYTES) return { error: 'too_large' };

  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.txt') && !name.endsWith('.tsv')) {
    return { error: 'unsupported' };
  }

  let parsed;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    parsed = parseCsvBuffer(buf);
  } catch {
    return { error: 'parse_failed' };
  }

  if (parsed.headers.length === 0) return { error: 'no_headers' };
  if (parsed.rows.length === 0) return { error: 'no_rows' };

  const mapping = detectMapping(parsed.headers);
  const usable = isMappingUsable(mapping);
  if (!usable.ok && usable.missing.includes('client_name')) {
    return { error: 'no_client_column' };
  }

  // Entitlement check happens before anything is stored. Single source of
  // truth: the plan is read from the database right here, per request.
  const { decision } = await asAdmin((db) =>
    assertEntitlement(db, session.workspaceId, 'import_proposals', { incoming: parsed.rows.length }),
  );
  if (!decision.allowed) return { error: 'plan_limit' };

  const id = randomUUID();
  await withTenant(session.workspaceId, async (db) => {
    await db.query(
      `insert into imports (id, workspace_id, uploaded_by, filename, row_count, mapping, status, staged_rows, headers, encoding)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, 'parsed', $7::jsonb, $8::jsonb, $9)`,
      [
        id, session.workspaceId, session.userId, file.name, parsed.rows.length,
        JSON.stringify(mapping), JSON.stringify(parsed.rows), JSON.stringify(parsed.headers),
        parsed.encoding,
      ],
    );
  });

  const from = String(formData.get('from') ?? '') === 'onboarding' ? '?from=onboarding' : '';
  redirect(`/${session.locale}/import/${id}/mapping${from}`);
}

/** Step 2 — persist the user's column choices. */
export async function saveMappingAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const importId = String(formData.get('importId'));
  const fields: TargetField[] = [
    'client_name', 'title', 'amount_cents', 'sent_at', 'stage',
    'last_touch_at', 'touch_count', 'contact_email', 'external_ref',
  ];
  const mapping: Mapping[] = fields.map((field) => {
    const column = String(formData.get(`map_${field}`) ?? '');
    return { field, column: column === '' ? null : column, confidence: 1 };
  });

  const usable = isMappingUsable(mapping);
  if (!usable.ok) {
    redirect(`/${session.locale}/import/${importId}/mapping?error=missing`);
  }

  await withTenant(session.workspaceId, async (db) => {
    await db.query(
      `update imports set mapping = $1::jsonb, status = 'mapped' where id = $2::uuid and workspace_id = $3::uuid`,
      [JSON.stringify(mapping), importId, session.workspaceId],
    );
  });
  const from = String(formData.get('from') ?? '') === 'onboarding' ? '?from=onboarding' : '';
  redirect(`/${session.locale}/import/${importId}/report${from}`);
}

/** Step 3 → 4 — dry-run then commit. */
export async function commitImportAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const importId = String(formData.get('importId'));

  const staged = await withTenant(session.workspaceId, async (db) =>
    db.query<{ staged_rows: unknown; mapping: unknown; filename: string }>(
      `select staged_rows, mapping, filename from imports where id = $1::uuid and workspace_id = $2::uuid`,
      [importId, session.workspaceId],
    ),
  );
  const row = staged.rows[0];
  if (!row) redirect(`/${session.locale}/import`);

  const rows = (row.staged_rows ?? []) as Record<string, unknown>[];
  const mapping = (row.mapping ?? []) as Mapping[];

  const existing = await withTenant(session.workspaceId, (db) => loadExisting(db, session.workspaceId));
  // Second gate, on purpose: enforcement lives in the action AND in the job,
  // never only in the UI. The plan is re-read from the database here.
  const { decision } = await asAdmin((db) =>
    assertEntitlement(db, session.workspaceId, 'import_proposals', { incoming: rows.length }),
  );
  if (!decision.allowed) {
    // Never drop rows silently: the whole import is refused with a message.
    redirect(`/${session.locale}/import?error=plan_limit`);
  }

  const result = importPipeline(rows, {
    mapping,
    existing,
    now: new Date(),
    holdoutRate: 0.2,
    // CSPRNG, same function as the repository path: the web and the repo agree
    // on who is in the control group, and nobody can predict it from a timestamp.
    assignArm: () => assignArm(0.2),
  });

  await withTenant(session.workspaceId, (db) =>
    commitImport(db, result, {
      workspaceId: session.workspaceId,
      userId: session.userId,
      filename: row.filename,
      holdoutRate: 0.2,
      mapping,
      maxRows: rows.length,
    }),
  );

  await asAdmin(async (db) => {
    await recordFunnel(db, session.workspaceId, session.userId, 'import_confirmed');
    const from = String(formData.get('from') ?? '');
    if (from === 'onboarding') {
      await patchOnboardingState(db, session.workspaceId, { stepDone: 'import', step: 4, stagedImportId: importId });
    }
  });

  if (String(formData.get('from') ?? '') === 'onboarding') {
    redirect(`/${session.locale}/onboarding/4`);
  }
  redirect(`/${session.locale}/calibration`);
}


