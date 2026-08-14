/** @jsxImportSource @opentui/solid */
import { createTeamWorkTui } from "./team-tui-plugin.mjs"
import { TeamSidebar } from "./team-sidebar.tsx"

export const createTeamWorkTuiPlugin = ({ isEnabled } = {}) => ({
  id: "team-work-runtime-tui",
  tui: createTeamWorkTui((props) => <TeamSidebar {...props} />, { isEnabled }),
})

export const TeamWorkTui = createTeamWorkTuiPlugin().tui

export default createTeamWorkTuiPlugin()
