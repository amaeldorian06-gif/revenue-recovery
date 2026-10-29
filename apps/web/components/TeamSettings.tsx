import { asAdmin } from '../lib/db';
import {
  listMembers, listApiKeys, listWebhookEndpoints, listDeadDeliveries,
} from '@rros/db/team';
import { inviteMemberAction, removeMemberAction, createApiKeyAction, revokeApiKeyAction,
         createWebhookAction, deleteWebhookAction, testWebhookAction } from '../lib/actions/team';
import type { Session } from '../lib/session';

/**
 * Settings sections for phase 08: members (roles + invitations), API keys
 * (shown once), webhooks (test event + dead letters), GDPR (export + delete).
 * Server component — every form posts to a server action gated by can().
 */
export async function TeamSettings({ session }: { session: Session }) {
  const fr = session.locale === 'fr';
  const [members, apiKeys, endpoints, dead] = await Promise.all([
    asAdmin((db) => listMembers(db, session.workspaceId)).catch(() => []),
    asAdmin((db) => listApiKeys(db, session.workspaceId)).catch(() => []),
    asAdmin((db) => listWebhookEndpoints(db, session.workspaceId)).catch(() => []),
    asAdmin((db) => listDeadDeliveries(db, session.workspaceId)).catch(() => []),
  ]);
  const canInvite = session.role === 'owner' || session.role === 'admin';
  const canManage = session.role === 'owner' || session.role === 'admin';
  const isOwner = session.role === 'owner';

  return (
    <>
      <div className="card" style={{ marginTop: 12 }} data-testid="team-card">
        <div className="pad">
          <strong>{fr ? 'Équipe' : 'Team'}</strong>
          <p className="sub" style={{ fontSize: 12.5 }}>
            {fr
              ? 'Propriétaire : facturation et taux de témoin. Admin : membres et boîtes. Membre : ses dossiers. Lecteur : lecture seule. La limite de sièges est vérifiée à l’acceptation de l’invitation.'
              : 'Owner: billing and holdout. Admin: members and mailboxes. Member: own dossiers. Viewer: read-only. The seat limit is enforced when an invitation is accepted.'}
          </p>
          <div style={{ marginTop: 8 }}>
            {members.map((m) => (
              <div key={m.id} data-testid="member-row" style={{ display: 'flex', gap: 10, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--line-2)', alignItems: 'center' }}>
                <span>{m.email}</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)' }} data-testid={`member-role-${m.role}`}>{m.role}</span>
                {canInvite && m.role !== 'owner' && (
                  <form action={removeMemberAction} style={{ marginLeft: 'auto' }}>
                    <input type="hidden" name="userId" value={m.id} />
                    <button className="btn" type="submit" style={{ padding: '3px 9px', fontSize: 11.5 }}>
                      {fr ? 'Retirer' : 'Remove'}
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
          {canInvite && (
            <form action={inviteMemberAction} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input name="email" type="email" required placeholder={fr ? 'collegue@agence.fr' : 'colleague@agency.com'} style={{ padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 13, flex: 1, minWidth: 180 }} data-testid="invite-email" />
              <select name="role" defaultValue="member" aria-label={fr ? 'Rôle du collègue invité' : 'Invited colleague role'} style={{ padding: '7px 8px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 13 }} data-testid="invite-role">
                <option value="admin">admin</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
              <button className="btn" type="submit" data-testid="invite-submit">{fr ? 'Inviter' : 'Invite'}</button>
            </form>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }} data-testid="api-card">
        <div className="pad">
          <strong>{fr ? 'API publique v1' : 'Public API v1'}</strong>
          <p className="sub" style={{ fontSize: 12.5 }}>
            {fr
              ? 'L’API prépare, n’envoie jamais : POST /v1/actions crée un brouillon, rien de plus. Docs : /docs/api.'
              : 'The API prepares, never sends: POST /v1/actions creates a draft, nothing more. Docs: /docs/api.'}
          </p>
          <div style={{ marginTop: 8 }}>
            {apiKeys.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucune clé.' : 'No keys.'}</p>}
            {apiKeys.map((k) => (
              <div key={k.id} data-testid="api-key-row" style={{ display: 'flex', gap: 10, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--line-2)', alignItems: 'center' }}>
                <code style={{ fontSize: 12.5 }}>{k.prefix}…</code>
                <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{k.name} · {k.scopes.join(', ')}</span>
                <form action={revokeApiKeyAction} style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="keyId" value={k.id} />
                  <button className="btn" type="submit" style={{ padding: '3px 9px', fontSize: 11.5 }}>{fr ? 'Révoquer' : 'Revoke'}</button>
                </form>
              </div>
            ))}
          </div>
          {isOwner && (
            <form action={createApiKeyAction} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input name="name" required placeholder={fr ? 'nom de la clé (ex. CRM)' : 'key name (e.g. CRM)'} style={{ padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 13, flex: 1, minWidth: 160 }} data-testid="api-key-name" />
              <button className="btn" type="submit" data-testid="api-key-create">{fr ? 'Créer une clé' : 'Create key'}</button>
            </form>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }} data-testid="webhooks-card">
        <div className="pad">
          <strong>{fr ? 'Webhooks' : 'Webhooks'}</strong>
          <p className="sub" style={{ fontSize: 12.5 }}>
            {fr
              ? 'Signés HMAC-SHA256 (t=…,v1=…), 3 essais (10 s, 60 s, 300 s), puis lettre morte visible ici. HTTPS obligatoire.'
              : 'HMAC-SHA256 signed (t=…,v1=…), 3 attempts (10 s, 60 s, 300 s), then a dead letter shown here. HTTPS required.'}
          </p>
          <div style={{ marginTop: 8 }}>
            {endpoints.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucun endpoint.' : 'No endpoints.'}</p>}
            {endpoints.map((e) => (
              <div key={e.id} data-testid="webhook-row" style={{ display: 'flex', gap: 10, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--line-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{e.url}</code>
                {e.disabledAt && <span style={{ color: '#b42318', fontWeight: 600, fontSize: 11.5 }}>{fr ? 'désactivé (20 échecs)' : 'disabled (20 failures)'}</span>}
                <form action={testWebhookAction} style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="endpointId" value={e.id} />
                  <button className="btn" type="submit" style={{ padding: '3px 9px', fontSize: 11.5 }} data-testid="webhook-test">
                    {fr ? 'Envoyer un événement de test' : 'Send a test event'}
                  </button>
                </form>
                <form action={deleteWebhookAction}>
                  <input type="hidden" name="endpointId" value={e.id} />
                  <button className="btn" type="submit" style={{ padding: '3px 9px', fontSize: 11.5 }}>{fr ? 'Supprimer' : 'Delete'}</button>
                </form>
              </div>
            ))}
          </div>
          {canManage && (
            <form action={createWebhookAction} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input name="url" required placeholder="https://votre-app.fr/webhooks/rros" style={{ padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 13, flex: 1, minWidth: 220 }} data-testid="webhook-url" />
              <input type="hidden" name="events" value="action.sent,reply.received,opportunity.won,opportunity.expired,weekly.snapshot,usage.threshold" />
              <button className="btn" type="submit" data-testid="webhook-create">{fr ? 'Ajouter' : 'Add'}</button>
            </form>
          )}
          {dead.length > 0 && (
            <div style={{ marginTop: 10 }} data-testid="dead-letters">
              <strong style={{ fontSize: 12.5 }}>{fr ? 'Lettres mortes' : 'Dead letters'}</strong>
              {dead.map((d) => (
                <p key={d.id} style={{ fontSize: 12, color: '#b42318' }}>
                  {d.event} — {d.lastError ?? 'error'} ({d.attempts} {fr ? 'essais' : 'attempts'})
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
