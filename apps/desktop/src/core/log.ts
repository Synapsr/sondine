// One structured line per event on stdout/stderr, which main inherits:
// `2026-11-05T18:02:11.123Z [core] info event {json}`, in UTC. Never log
// audio, transcript text, or the data directory's content.

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

function line(level: string, event: string, fields: Fields | undefined): string {
  const rest = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  return `${new Date().toISOString()} [core] ${level} ${event}${rest}`;
}

export const log = {
  info(event: string, fields?: Fields): void {
    console.log(line("info", event, fields));
  },
  warn(event: string, fields?: Fields): void {
    console.warn(line("warn", event, fields));
  },
  error(event: string, fields?: Fields): void {
    console.error(line("error", event, fields));
  },
};
