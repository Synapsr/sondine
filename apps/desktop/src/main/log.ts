// One structured line per event: `2026-11-05T18:02:11.123Z [main] info event {json}`, in UTC.

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

function line(level: string, event: string, fields: Fields | undefined): string {
  const rest = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  return `${new Date().toISOString()} [main] ${level} ${event}${rest}`;
}

export const log = {
  info: (event: string, fields?: Fields) => console.log(line("info", event, fields)),
  warn: (event: string, fields?: Fields) => console.warn(line("warn", event, fields)),
  error: (event: string, fields?: Fields) => console.error(line("error", event, fields)),
};
