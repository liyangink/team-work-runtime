/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"

import { loadTeamPanel } from "./team-sessions.mjs"

const STATUS = {
  busy: { glyph: "●", label: "工作中", color: "success" },
  retry: { glyph: "↻", label: "重试中", color: "warning" },
  idle: { glyph: "○", label: "空闲", color: "textMuted" },
  unknown: { glyph: "?", label: "未知", color: "textMuted" },
  stopped: { glyph: "■", label: "已停止", color: "textMuted" },
  lost: { glyph: "×", label: "已失联", color: "error" },
} as const

export function TeamSidebar(props: { api: any, context: any, sessionId: string }) {
  const [panel, setPanel] = createSignal<any>(null)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let poller: ReturnType<typeof setInterval> | undefined

  const refresh = async () => {
    const current = ++generation
    const next = await loadTeamPanel({
      projectRoot: props.api.state.path.worktree || props.api.state.path.directory,
      currentSessionId: props.sessionId,
      statusFor: (sessionId: string) => props.api.state.session.status(sessionId),
    }).catch(() => null)
    if (current === generation) setPanel(next)
  }
  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 120)
  }

  createEffect(() => {
    props.sessionId
    void refresh()
  })
  poller = setInterval(() => void refresh(), 5_000)
  const dispose = [
    props.api.event.on("session.status", scheduleRefresh),
    props.api.event.on("session.idle", scheduleRefresh),
    props.api.event.on("session.created", scheduleRefresh),
    props.api.event.on("session.updated", scheduleRefresh),
    props.api.event.on("session.deleted", scheduleRefresh),
  ]
  onCleanup(() => {
    generation += 1
    if (timer) clearTimeout(timer)
    if (poller) clearInterval(poller)
    for (const unsubscribe of dispose) unsubscribe()
  })

  const colors = () => props.context.theme
  const navigate = (sessionId: string) => props.api.route.navigate("session", { sessionID: sessionId })

  return (
    <Show when={panel()?.members?.length}>
      <box flexDirection="column" gap={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={colors().text}><b>Team</b></text>
          <text fg={colors().textMuted}>{panel().taskId}</text>
        </box>
        <Show when={panel().leadSessionId !== props.sessionId}>
          <box onMouseDown={() => navigate(panel().leadSessionId)}>
            <text fg={colors().accent}>← Lead</text>
          </box>
        </Show>
        <For each={panel().members}>{(member: any) => {
          const status = () => STATUS[member.status as keyof typeof STATUS] ?? STATUS.unknown
          return (
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => member.navigable && navigate(member.sessionId)}
            >
              <text fg={colors()[status().color]}>{status().glyph}</text>
              <box flexDirection="column" flexGrow={1} minWidth={0}>
                <text
                  fg={member.focused ? colors().accent : colors().text}
                  wrapMode="none"
                  truncate={true}
                >
                  {member.title}
                </text>
                <text fg={colors().textMuted} wrapMode="none" truncate={true}>
                  {member.agent} · {member.workItemId} · {status().label}
                </text>
              </box>
            </box>
          )
        }}</For>
      </box>
    </Show>
  )
}
