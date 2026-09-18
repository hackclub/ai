type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const serializeError = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };

const emit = (level: Level, msg: string, fields: Fields = {}) => {
  const record: Fields = { time: new Date().toISOString(), level, msg };
  for (const [key, value] of Object.entries(fields)) {
    record[key] = key === "error" ? serializeError(value) : value;
  }
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else console.log(line);
};

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
