import { loadUserConfig, resolveUserConfigRoot } from "../team-work/installer/user-config.mjs"
import { loadOpenCodeActivation } from "../team-work/opencode-activation.mjs"
import { createTeamWorkTuiPlugin } from "../team-work/tui/team-work-tui.tsx"

export default createTeamWorkTuiPlugin({
  isEnabled: async () => Boolean(await loadOpenCodeActivation(() => loadUserConfig({ configRoot: resolveUserConfigRoot() }))),
})
