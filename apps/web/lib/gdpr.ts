import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { asAdmin } from './db';
import { collectWorkspace } from '@rros/db/gdpr';
import { hashToken } from '@rros/db/team';

/**
 * GDPR export builder. A real ZIP (store method, no compression) so any
 * unzip tool opens it: README.txt explains each file, data.json holds every
 * row of the workspace, opportunities.csv is the flat table. Generated
 * synchronously at request time (a workspace export is small enough), stored
 * under var/exports, downloadable for 24 h with a one-shot-ish token.
 */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

interface ZipEntry { header: Buffer; central: Buffer; size: number }

function zipEntry(name: string, content: Buffer, offset: number): ZipEntry {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(content);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0x0800, 6);      // UTF-8 names
  local.writeUInt16LE(0, 8);           // store — no compression, any unzip opens it
  local.writeUInt16LE(0, 10);          // time
  local.writeUInt16LE(0x5221, 12);     // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);        // version made by
  central.writeUInt16LE(20, 6);        // version needed
  central.writeUInt16LE(0x0800, 8);    // UTF-8
  central.writeUInt16LE(0, 10);        // store
  central.writeUInt16LE(0, 12); central.writeUInt16LE(0x5221, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  nameBuf.copy(central, 46);
  return { header: local, central, size: content.length };
}

/** Exported for the strict-structure test — the format contract, not an API. */
export function buildZip(files: { name: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const entry = zipEntry(f.name, Buffer.from(f.content, 'utf8'), offset);
    chunks.push(entry.header);
    // The stored content itself:
    chunks.push(Buffer.from(f.content, 'utf8'));
    centrals.push(entry.central);
    offset += entry.header.length + entry.size;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);       // central directory start
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

export interface ExportResult {
  fileName: string;
  downloadPath: string;
  expiresAt: Date;
}

export async function buildExport(workspaceId: string, requestedBy: string, locale: 'fr' | 'en'): Promise<ExportResult> {
  const snapshot = await asAdmin((c) => collectWorkspace(c, workspaceId));
  const dataJson = JSON.stringify({ workspace: snapshot[0]?.rows[0] ?? null, tables: snapshot }, null, 2);
  const opps = snapshot.find((t) => t.table === 'opportunities')?.rows ?? [];
  const csvHeader = 'id,client_name,title,amount_cents,status,arm,stage,created_at\n';
  const csv = csvHeader + opps.map((o) =>
    [o.id, o.client_name, o.title, o.amount_cents, o.status, o.arm, o.stage, o.created_at]
      .map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(','),
  ).join('\n');
  const readme = locale === 'fr'
    ? [
        'Export RGPD de votre espace de travail.',
        '',
        'data.json           — toutes les lignes de toutes les tables vous concernant.',
        'opportunities.csv   — la table des dossiers, prête pour un tableur.',
        '',
        'Le lien de téléchargement expire après 24 heures.',
        'Aucune donnée d\'un autre espace de travail ne figure dans cet export.',
      ].join('\n')
    : [
        'GDPR export of your workspace.',
        '',
        'data.json           — every row of every table about your workspace.',
        'opportunities.csv   — the opportunities table, spreadsheet-ready.',
        '',
        'The download link expires after 24 hours.',
        'No row from any other workspace is included.',
      ].join('\n');

  const zip = buildZip([
    { name: 'README.txt', content: readme },
    { name: 'data.json', content: dataJson },
    { name: 'opportunities.csv', content: csv },
  ]);

  const dir = join(process.cwd(), 'var', 'exports');
  await mkdir(dir, { recursive: true });
  const fileName = `export-${workspaceId.slice(0, 8)}-${Date.now()}.zip`;
  await writeFile(join(dir, fileName), zip);

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await asAdmin((c) =>
    c.query(
      `insert into export_requests (workspace_id, requested_by, status, file_name, token_hash, expires_at)
       values ($1::uuid, $2::uuid, 'ready', $3::text, $4::text, $5::timestamptz)`,
      [workspaceId, requestedBy, fileName, hashToken(token), expiresAt.toISOString()],
    ),
  );
  await asAdmin((c) =>
    c.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'workspace.exported', 'workspace', $1::text, $3::jsonb)`,
      [workspaceId, requestedBy, JSON.stringify({ fileName })],
    ),
  );
  return { fileName, downloadPath: `/api/me/export/${token}`, expiresAt };
}

/** Token → file, if the request exists, belongs to a live workspace, not expired. */
export async function resolveExportToken(token: string): Promise<{ fileName: string; workspaceId: string } | null> {
  const r = await asAdmin((c) =>
    c.query<{ file_name: string; workspace_id: string; expires_at: string }>(
      `select e.file_name, e.workspace_id, e.expires_at::text
         from export_requests e
         join workspaces w on w.id = e.workspace_id
        where e.token_hash = $1::text and e.status = 'ready'
          and w.deleted_at is null`,
      [createHash('sha256').update(token).digest('hex')],
    ),
  );
  const row = r.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { fileName: row.file_name, workspaceId: row.workspace_id };
}
