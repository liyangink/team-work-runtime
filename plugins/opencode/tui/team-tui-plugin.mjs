export function createTeamWorkTui(renderTeamSidebar) {
  if (typeof renderTeamSidebar !== "function") throw new TypeError("renderTeamSidebar must be a function")
  return async function TeamWorkTui(api) {
    api.slots.register({
      order: 300,
      slots: {
        sidebar_content: (context, props) => renderTeamSidebar({
          api,
          context,
          sessionId: props.session_id,
        }),
      },
    })
  }
}
