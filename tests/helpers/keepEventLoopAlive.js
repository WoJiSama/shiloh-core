export function keepEventLoopAlive(t) {
  // Stubbed operations have no I/O handles and production deadlines do not keep Node alive.
  const handle = setTimeout(() => {}, 10_000)
  t.after(() => clearTimeout(handle))
}
