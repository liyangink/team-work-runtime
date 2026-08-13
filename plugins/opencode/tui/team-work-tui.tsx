/** @jsxImportSource @opentui/solid */
import { createTeamWorkTui } from "./team-tui-plugin.mjs"
import { TeamSidebar } from "./team-sidebar.tsx"

export const TeamWorkTui = createTeamWorkTui((props) => <TeamSidebar {...props} />)

export default {
  id: "team-work-runtime-tui",
  tui: TeamWorkTui,
}
