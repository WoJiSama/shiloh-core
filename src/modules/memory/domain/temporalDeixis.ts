const TIME_DEIXIS_PATTERN = /上次|上回|昨天|前天|那天|之前说|之前聊|前几天|上周|刚才说|早些时候/

export function hasTemporalDeixis(text = "") {
  return TIME_DEIXIS_PATTERN.test(String(text || ""))
}
