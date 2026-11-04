/**
 * The "run /clear" notice. On a new day the proxy summarizes the earlier history, saves it and waits for the
 * user to clear the chat; the next chat then receives that summary once. The user has to be told, and told in
 * a place they see, so the same wording is carried by three things: a popup when the wait begins, a warning
 * icon on the status bar item for as long as it lasts, and a banner on top of the dashboard that the click opens.
 * None of them is a surface of its own: the icon belongs to the existing item and the banner to the existing page.
 */

/** The popup's button, and what a click on it does: open the dashboard, where the banner explains the steps. */
export const CLEAR_NOTICE_ACTION = 'Open dashboard';

/** The day the chat started, as it is said in the notice: `Fri, Oct 30` (local time, the year only when it is not this one), or "an earlier day" when it is not known. */
export function formatChatSince(since: number | undefined, now: number = Date.now()): string {
  if (since === undefined || !Number.isFinite(since)) {
    return 'an earlier day';
  }
  const date = new Date(since);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}

/** When the ledger first saw this chat (epoch ms): its oldest entry with that session id, or undefined without one. */
export function chatFirstSeen(entries: ReadonlyArray<{ sessionId?: string; timestamp: string }>, sessionId: string | undefined): number | undefined {
  if (!sessionId) {
    return undefined;
  }
  let first: number | undefined;
  for (const entry of entries) {
    const at = entry.sessionId === sessionId ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(at) && (first === undefined || at < first)) {
      first = at;
    }
  }
  return first;
}

/** The popup text: what happened, why it matters, what to do, and what the new chat will get. */
export function clearNoticeMessage(since?: number): string {
  return (
    `New day: this chat has been open since ${formatChatSince(since)}, and Claude Code resends all of its history with every message, which uses more tokens. ` +
    'We summarized that history and saved it. Run /clear and send your next message: the new chat starts with that summary, so nothing is lost.'
  );
}

/** The status bar tooltip's paragraph (Markdown with theme icons). */
export function clearTooltipMarkdown(since?: number): string {
  return (
    `\n$(warning) **New day:** this chat has been open since ${formatChatSince(since)}, and Claude Code resends all of its history with every message, which uses more tokens. ` +
    'The proxy summarized it and saved it. Run `/clear` and send your next message: the new chat starts with that summary, so nothing is lost. ' +
    'Click this icon for details.\n'
  );
}

/** The banner on top of the dashboard, above the tabs, so it shows on whichever tab is open. Only the date is variable, and it is made here, not read from the ledger. */
export function clearBannerHtml(since?: number): string {
  return `<div class="clear-banner" role="status" data-clear-banner>
    <strong>New day: this chat has been open since ${formatChatSince(since)}.</strong>
    <p>Claude Code resends a chat's whole history with every message, so carrying on in it uses more tokens. The proxy has already summarized that history and saved it.</p>
    <ol>
      <li>Run <code>/clear</code> in Claude Code.</li>
      <li>Send your next message. The new chat starts with the saved summary, so Claude keeps the thread and nothing is lost.</li>
    </ol>
    <div class="stat-sub">This notice goes away once the new chat has received the summary.</div>
  </div>`;
}

/**
 * Shows the popup once per wait: when the summary starts waiting, not on every turn while it keeps waiting,
 * and again only after it was delivered and a later day leaves a new one. Dismissing it does not bring it back;
 * the icon and the banner stay for as long as the wait lasts.
 */
export class ClearNotifier {
  private pending = false;

  constructor(
    /** Shows the popup with one button and resolves to the button pressed, or undefined when it was dismissed. */
    private readonly show: (message: string, action: string) => PromiseLike<string | undefined>,
    private readonly openDashboard: () => void
  ) {}

  update(pending: boolean, since?: number): void {
    const begins = pending && !this.pending;
    this.pending = pending;
    if (!begins) {
      return;
    }
    void Promise.resolve(this.show(clearNoticeMessage(since), CLEAR_NOTICE_ACTION)).then((choice) => {
      if (choice === CLEAR_NOTICE_ACTION) {
        this.openDashboard();
      }
    });
  }
}
