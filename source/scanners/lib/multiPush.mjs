// Silent-mode stub for Trade Odds standalone scanners.
// Real multiPush (Slack/Telegram/WhatsApp) lives on the Mac mini; on Windows
// we want the scanners to populate memory/*.json only — no duplicate alerts.
export async function multiPush() { /* no-op in standalone mode */ return { skipped: true }; }
export async function multiPushText() { return { skipped: true }; }
export async function multiPushImage() { return { skipped: true }; }
