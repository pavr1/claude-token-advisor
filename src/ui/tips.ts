/**
 * Tips to save tokens, for the selected range and repo of the Token Improver tab. Two kinds: what the
 * ledger of that selection says (cache that had to be written again, very long histories, Opus), and a
 * few facts about the cache and the weight of each model that are worth keeping in mind.
 */
import { aggregate, groupTurns, isFailedHit, isKeepAlivePing, LedgerEntry } from '../analytics/tracker';
import { KEEP_ALIVE_INTERVAL_MS } from '../proxy/keepAlive';
import { FALLBACK_MODELS } from '../proxy/modelCatalog';
import { cacheMultipliers, modelWeight } from '../proxy/pricing';
import { hitBalanceOf } from './hitBalance';
import { compact, escapeHtml, formatPercent } from './shared';

export type TipTone = 'good' | 'warn' | 'info';

export interface Tip {
  tone: TipTone;
  /** The part in bold: the finding, or the rule. */
  lead: string;
  text: string;
}

/** Requests this long, on average, carry a history worth cutting: they resend it on every step. */
const LONG_HISTORY_TOKENS = 200_000;
/** Below this share of cache reads the cache is not doing its job; above it, it is worth saying so. */
const HEALTHY_READ_SHARE = 0.9;
/** A handful of requests says nothing about how the cache behaves. */
const MIN_HITS_FOR_PRAISE = 5;

/** A multiplier as it is said aloud: 0.1×, 0.05×, 0.025×. */
const times = (multiplier: number): string => `${Number(multiplier.toPrecision(2))}×`;

/** The Opus the price comparison is made against (Claude Code's own default family); update it when a newer Opus becomes the default. */
const OPUS_MODEL_ID = 'claude-opus-5-5';

/** How often the keep-alive pings, in minutes, as the proxy really sends it. */
const KEEP_ALIVE_EVERY_MINUTES = KEEP_ALIVE_INTERVAL_MS / 60_000;

/** The distinct read multipliers the selection's hits were billed at (each model has its own), lowest first. Unpriced reads are left out. */
function readMultipliers(hits: readonly LedgerEntry[]): number[] {
  const seen = new Set<number>();
  for (const entry of hits) {
    if ((entry.cacheReadTokens ?? 0) <= 0) {
      continue;
    }
    const rate = (entry.cacheMultipliers ?? cacheMultipliers(entry.servedModel)).read;
    if (rate > 0) {
      seen.add(Number(rate.toPrecision(2)));
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** What the ledger of the selection says. Pings and failed hits are nobody's request, so they are left out. */
export function dataTips(entries: readonly LedgerEntry[], keepAliveMinutes: number): Tip[] {
  const hits = entries.filter((entry) => !isFailedHit(entry) && !isKeepAlivePing(entry));
  if (hits.length === 0) {
    return [];
  }
  const tips: Tip[] = [];
  const stats = aggregate(hits);
  const turns = groupTurns(hits);

  // A turn is costly when it holds a hit whose cache writes cost more than its reads saved.
  const costly = turns.filter((turn) => {
    const units = hitBalanceOf(turn.entries).units;
    return units === 'red' || units === 'amber';
  });
  if (costly.length > 0) {
    tips.push({
      tone: 'warn',
      lead: `${costly.length.toLocaleString()} of ${turns.length.toLocaleString()} turns had a hit that wrote more cache than it saved.`,
      text:
        keepAliveMinutes > 0
          ? `An expired cache is written again in full. The keep-alive renews it every ~${KEEP_ALIVE_EVERY_MINUTES} minutes for up to ${keepAliveMinutes} minutes after your last request, so a longer pause, or the computer going to sleep, lets it expire. Open the amber or red rows to see which hit it was.`
          : 'An expired cache is written again in full, and a pause of more than 5 minutes lets it expire. Open the amber or red rows to see which hit it was, and work in one stretch or turn the keep-alive on (setting claudeTokenImprover.keepAliveMaxMinutes).',
    });
  }

  const cached = stats.cacheReadTokens + stats.cacheWriteTokens;
  if (hits.length >= MIN_HITS_FOR_PRAISE && cached > 0 && stats.cacheReadTokens / cached >= HEALTHY_READ_SHARE) {
    // The read price is each model's own (0.1× for most, 0.05× on the newest Sonnet and Opus), so say what these hits paid.
    const rates = readMultipliers(hits);
    const price =
      rates.length === 0
        ? 'a fraction of'
        : rates.length === 1
          ? times(rates[0])
          : `${times(rates[0])} to ${times(rates[rates.length - 1])} (depending on the model)`;
    tips.push({
      tone: 'good',
      lead: `The cache is working: ${formatPercent((stats.cacheReadTokens / cached) * 100)} of cached tokens were reads.`,
      text: `A read costs ${price} a regular input token, so this is where most of the saving comes from.`,
    });
  }

  const averageRaw = stats.turns > 0 ? stats.rawTokens / stats.turns : 0;
  if (averageRaw >= LONG_HISTORY_TOKENS) {
    tips.push({
      tone: 'warn',
      lead: `Requests average ${compact(averageRaw)} tokens before the proxy touches them.`,
      text: 'Claude Code resends the whole history on every step. Start a new chat (/clear) when you change task: the proxy summarizes old history, but less history is cheaper still.',
    });
  }

  const opus = hits.filter((entry) => /opus/i.test(entry.servedModel ?? '')).length;
  if (opus > 0) {
    tips.push({
      tone: 'warn',
      lead: `${opus.toLocaleString()} of ${hits.length.toLocaleString()} requests ran on Opus.`,
      text: 'Opus costs more per token than Sonnet. Pick the model with /model and keep Opus for what needs it.',
    });
  }

  return tips;
}

/** The keep-alive, said as it is: what it does, how long, what it costs, and what still lets the cache expire. */
function keepAliveTip(keepAliveMinutes: number): Tip {
  if (keepAliveMinutes > 0) {
    return {
      tone: 'info',
      lead: 'The keep-alive keeps the cache warm while you pause.',
      text:
        `Every ~${KEEP_ALIVE_EVERY_MINUTES} minutes the proxy replays your last request with a one-token answer, which renews the cache for the price of one read of the prefix. ` +
        `It keeps doing it for up to ${keepAliveMinutes} minutes after your last request (setting claudeTokenImprover.keepAliveMaxMinutes, 0 turns it off). ` +
        'A longer pause, or a computer that goes to sleep, lets the cache expire and the next request pays to write it again. On a subscription plan each ping counts against your usage limit.',
    };
  }
  return {
    tone: 'info',
    lead: 'The keep-alive is off.',
    text: 'Without it, a pause of more than 5 minutes lets the cache expire and the next request pays to write it again. Set claudeTokenImprover.keepAliveMaxMinutes above 0 and the proxy renews the cache with a one-token ping every few minutes after your last request.',
  };
}

/**
 * What is always worth remembering, whatever the data says. The multipliers are the pricing table's own,
 * so a repricing shows here without a code change; the practices come from Anthropic's "Manage costs
 * effectively" page for Claude Code.
 */
export function generalTips(keepAliveMinutes: number): Tip[] {
  const sonnetRead = times(cacheMultipliers(FALLBACK_MODELS.sonnet).read);
  const haikuRead = times(cacheMultipliers(FALLBACK_MODELS.haiku).read);
  return [
    {
      tone: 'info',
      lead: 'The cache lasts 5 minutes.',
      text:
        'To make it last 1 hour, set claudeTokenImprover.cacheTtl to 1h (Settings, search "cacheTtl"; or in settings.json: "claudeTokenImprover.cacheTtl": "1h"). The proxy restarts by itself with the new value. ' +
        `A write then costs 2× an input token instead of 1.25×, so keep 5m unless you are measuring on purpose. A read costs a fraction of an input token that depends on the model: ${sonnetRead} on ${FALLBACK_MODELS.sonnet}, ${haikuRead} on ${FALLBACK_MODELS.haiku}.`,
    },
    keepAliveTip(keepAliveMinutes),
    {
      tone: 'info',
      lead: 'Compare in units, not in tokens.',
      text: 'Each model has its own weight (Sonnet input = 1), so the same tokens cost different units on Haiku, Sonnet or Opus.',
    },
    {
      tone: 'info',
      lead: 'One chat per task.',
      text: 'A long history is resent on every request. Use /clear when you change task (/rename first if you want to come back to it with /resume).',
    },
    {
      tone: 'info',
      lead: 'By default the first request starts on Sonnet, not Opus.',
      text:
        'If the first request after the proxy starts is Opus, it is sent to Sonnet (setting claudeTokenImprover.startupSonnetDefault, on by default). ' +
        `Input costs ${times(modelWeight(OPUS_MODEL_ID) / modelWeight(FALLBACK_MODELS.sonnet))} on ${OPUS_MODEL_ID} against 1× on ${FALLBACK_MODELS.sonnet}. ` +
        'The default is Sonnet, but you can switch to another model whenever you want with /model: only that first request changes, and the model you pick is left as it is. To keep Opus from the very first request, turn the setting off.',
    },
    {
      tone: 'info',
      lead: 'Pick the model for the job.',
      text: 'Sonnet handles most coding tasks; keep Opus for complex architecture or multi-step reasoning, and give simple subagents model: haiku. Switch with /model.',
    },
    {
      tone: 'info',
      lead: 'Lower the effort for simple tasks.',
      text: 'Thinking is billed as output. Use /effort to lower it; on Opus 5.5, Sonnet 5.5, Haiku 5.5 and the Fable models thinking cannot be turned off, so effort is the lever.',
    },
    {
      tone: 'info',
      lead: 'Keep CLAUDE.md short.',
      text: 'It is loaded at the start of every session. Aim for under 200 lines and move workflows to skills, which load only when they are used.',
    },
    {
      tone: 'info',
      lead: 'Compact on your terms.',
      text: '/compact with instructions (for example /compact Focus on code samples and API usage), or a "Compact instructions" section in CLAUDE.md, says what to keep. Compacting a large context is itself a large request; /clear costs nothing.',
    },
    {
      tone: 'info',
      lead: 'Send noisy work to subagents.',
      text: 'Tests, logs and documentation lookups stay in the subagent\'s context and only a summary comes back. Their requests still count, so give them a smaller model.',
    },
    {
      tone: 'info',
      lead: 'Filter before Claude reads.',
      text: 'A hook can turn a 10,000-line log into its ERROR lines, from tens of thousands of tokens to hundreds.',
    },
    {
      tone: 'info',
      lead: 'Prefer CLI tools to MCP servers.',
      text: 'gh, aws, gcloud and sentry-cli add no per-tool listing to the context. Disable the servers you do not use with /mcp, and see what takes space with /context.',
    },
    {
      tone: 'info',
      lead: 'Ask for something specific.',
      text: '"Add input validation to the login function in auth.ts" reads far less than "improve this codebase".',
    },
    {
      tone: 'info',
      lead: 'Plan first, correct early.',
      text: 'Shift+Tab for plan mode before a complex change. If Claude heads the wrong way, press Esc at once and use /rewind to go back to a checkpoint.',
    },
    {
      tone: 'info',
      lead: 'Idle sessions can still cost.',
      text: 'A /loop or scheduled task fires while the session is idle and resends the whole context each time; after a pause longer than the cache lifetime that is a cache miss too.',
    },
  ];
}

const item = (tip: Tip): string => `<li class="tip tip-${tip.tone}"><strong>${escapeHtml(tip.lead)}</strong> ${escapeHtml(tip.text)}</li>`;

/** The content: what the data says, then what is always worth remembering. */
export function tipsSectionHtml(entries: readonly LedgerEntry[], keepAliveMinutes: number): string {
  const found = dataTips(entries, keepAliveMinutes);
  const data = found.length > 0 ? `<ul class="tips">${found.map(item).join('')}</ul>` : '<div class="empty">Nothing to flag in this selection.</div>';
  return `<h2>Tips to save tokens</h2>
  ${data}
  <div class="stat-sub" style="margin:10px 0 2px">Always worth keeping in mind</div>
  <ul class="tips">${generalTips(keepAliveMinutes).map(item).join('')}</ul>`;
}

/**
 * The popup the Tips button opens. It sits in the page, hidden, so an update of the dashboard keeps it
 * current while it is open; the page script shows it by adding `tips-open`.
 */
export function tipsPopupHtml(entries: readonly LedgerEntry[], keepAliveMinutes: number): string {
  return `<div class="tips-modal" data-tips-modal>
    <div class="tips-card" role="dialog" aria-label="Tips to save tokens">
      <button type="button" class="tips-close" data-close-tips aria-label="Close">×</button>
      ${tipsSectionHtml(entries, keepAliveMinutes)}
    </div>
  </div>`;
}
