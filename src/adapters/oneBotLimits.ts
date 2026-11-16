// Two 2 MiB inline images expand to about 5.34 MiB in base64. Leave bounded
// room for OneBot metadata while retaining the per-image binary limits.
export const ONEBOT_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024
