/**
 * Deterministic composer — no network, no key, no surprise.
 *
 * It exists for three reasons: the product must work in a trial with no API key
 * configured, the whole send flow must be demonstrable end to end, and a
 * deterministic provider makes the integration tests honest — they exercise the
 * real pipeline (context → prompt → parse → guardrails) without pretending a
 * model answered.
 *
 * It is not a fallback for quality: when a model is configured, this one is not
 * used. It writes like a careful assistant, not like a copywriter.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../generate.ts';
import type { PromptContext, Tone } from '../context.ts';

export class LocalComposer implements LlmProvider {
  readonly name = 'local-composer';

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const ctx = readContext(req.user, req.system);
    return { text: JSON.stringify(compose(ctx)), model: 'local-composer-v1' };
  }
}

/** The facts are read back from the user prompt so the composer sees the same
 *  input the model would — including the retry note, which it ignores on purpose. */
function readContext(user: string, system: string): PromptContext {
  const get = (key: string) => {
    const m = user.match(new RegExp(`^${key}: (.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  const days = Number(get('days_since_send')) || 0;
  const lastTouch = get('last_touch_days');
  const toneMatch = system.match(/(?:Ton|Tone) : (warm|direct|formal)/);
  return {
    locale: (get('locale') === 'en' ? 'en' : 'fr') as PromptContext['locale'],
    tone: (toneMatch?.[1] ?? 'warm') as Tone,
    contactFirstName: get('contact_first_name') === '(inconnu)' ? null : get('contact_first_name'),
    clientName: get('client'),
    amount: get('amount'),
    sentDate: get('sent_date'),
    title: get('title'),
    stage: get('stage'),
    touchNumber: Number(get('touch_number')) || 1,
    daysSinceSend: days,
    lastTouchDays: lastTouch === 'n/a' ? null : Number(lastTouch),
    contextNote: get('context_note') === '(none)' ? '' : get('context_note'),
    previousMessages: [],
    senderName: get('sender_name') || 'L’équipe',
  };
}

export function compose(ctx: PromptContext, tone: Tone = ctx.tone): { subject: string; body: string } {
  const first = ctx.contactFirstName ?? (ctx.locale === 'fr' ? 'Madame, Monsieur' : 'there');
  const greeting = ctx.locale === 'fr' ? `Bonjour ${first},` : `Hello ${first},`;
  const sign = ctx.locale === 'fr' ? `Bien à vous,\n${ctx.senderName}` : `Kind regards,\n${ctx.senderName}`;
  const note = ctx.contextNote ? `${ctx.contextNote}\n` : '';

  // The opening varies with the touch number so two consecutive follow-ups never
  // share their trigrams — the validator would refuse them, rightly.
  const subject =
    ctx.locale === 'fr'
      ? `${ctx.title} — votre avis`
      : `${ctx.title} — your thoughts`;

  if (ctx.locale === 'en') {
    const bodies: Record<Tone, string> = {
      warm: [
        greeting,
        '',
        `I am writing about the proposal “${ctx.title}”, sent on ${ctx.sentDate}, for ${ctx.amount}.`,
        note,
        `It has been with you for ${ctx.daysSinceSend} days, and I would rather follow your pace than push.`,
        'Have you had a chance to look at it?',
        'If the timing is wrong or priorities have moved, just tell me and I will stop nudging.',
        '',
        sign,
      ].join('\n'),
      direct: [
        greeting,
        '',
        `A short note about “${ctx.title}”, sent on ${ctx.sentDate} for ${ctx.amount}.`,
        note,
        `We are ${ctx.daysSinceSend} days in, and I have no way to know where the decision stands on your side.`,
        'Is this still something you want to move forward with?',
        'Either way is fine — a one-line answer is enough for me to close the loop or keep it open.',
        '',
        sign,
      ].join('\n'),
      formal: [
        greeting,
        '',
        `I am writing to you regarding the proposal “${ctx.title}”, which we sent on ${ctx.sentDate} for ${ctx.amount}.`,
        note,
        `As ${ctx.daysSinceSend} days have passed since then, I wanted to make sure the document reached you and remained useful.`,
        'Would you like me to send any additional details?',
        'Should the project be on hold, please let me know and I will refrain from writing again until you say so.',
        '',
        sign,
      ].join('\n'),
    };
    return { subject, body: bodies[tone] };
  }

  const bodies: Record<Tone, string> = {
    warm: [
      greeting,
      '',
      `Je vous écris au sujet de la proposition « ${ctx.title} », transmise le ${ctx.sentDate} pour un montant de ${ctx.amount}.`,
      note,
      `Cela fait ${ctx.daysSinceSend} jours qu’elle est entre vos mains, et je préfère suivre votre rythme plutôt que de vous presser.`,
      'Avez-vous pu en prendre connaissance ?',
      'Si le moment n’est pas le bon ou si les priorités ont changé, dites-le-moi simplement et je cesserai de vous solliciter.',
      '',
      sign,
    ].join('\n'),
    direct: [
      greeting,
      '',
      `Un mot au sujet de « ${ctx.title} », envoyée le ${ctx.sentDate} pour ${ctx.amount}.`,
      note,
      `Nous sommes ${ctx.daysSinceSend} jours plus loin, et je n’ai aucun moyen de savoir où en est la décision de votre côté.`,
      'Est-ce un sujet que vous souhaitez toujours faire avancer ?',
      'Les deux réponses me vont : une ligne suffit pour que je ferme la boucle ou que je la garde ouverte.',
      '',
      sign,
    ].join('\n'),
    formal: [
      greeting,
      '',
      `Je vous adresse ce message au sujet de la proposition « ${ctx.title} », que nous vous avons fait parvenir le ${ctx.sentDate} pour un montant de ${ctx.amount}.`,
      note,
      `${ctx.daysSinceSend} jours se sont écoulés depuis, et je souhaitais m’assurer que le document vous est bien parvenu et reste utile.`,
      'Souhaitez-vous que je vous transmette un complément d’information ?',
      'Si le projet est en suspens, n’hésitez pas à me le signaler : je m’abstiendrai de vous écrire jusqu’à votre retour.',
      '',
      sign,
    ].join('\n'),
  };

  return { subject, body: bodies[tone] };
}
