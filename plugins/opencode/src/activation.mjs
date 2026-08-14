export async function loadOpenCodeActivation(loadConfig) {
  if (typeof loadConfig !== "function") throw new TypeError("loadConfig must be a function")
  const loaded = await loadConfig()
  return loaded?.platform?.enabled === false ? null : loaded
}
