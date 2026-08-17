export function createTeamWorkTui(renderTeamSidebar, { isEnabled = async () => true } = {}) {
  if (typeof renderTeamSidebar !== "function") throw new TypeError("renderTeamSidebar must be a function")
  if (typeof isEnabled !== "function") throw new TypeError("isEnabled must be a function")
  return async function TeamWorkTui(api) {
    if (!await isEnabled()) return
    api.slots.register({
      order: 350,
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
