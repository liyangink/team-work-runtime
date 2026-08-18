/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo } from "solid-js"

import { loadTeamPanelSync, resolvePanelProjectRoot } from "./team-sessions.mjs"

const STATUS = {
  busy: { glyph: "●", label: "工作中", color: "success" },
  retry: { glyph: "↻", label: "重试中", color: "warning" },
  idle: { glyph: "○", label: "空闲", color: "textMuted" },
  unknown: { glyph: "·", label: "状态未载入", color: "textMuted" },
  stopped: { glyph: "■", label: "已停止", color: "textMuted" },
  lost: { glyph: "×", label: "已失联", color: "error" },
} as const

export function TeamSidebar(props: { api: any, context: any, sessionId: string }) {
  const panel = createMemo(() => {
    // OpenCode 官方 session state 负责触发重算；不在 TUI 组件中创建定时器或事件订阅。
    props.api.state.session.count()
    return loadTeamPanelSync({
      projectRoot: resolvePanelProjectRoot(props.api.state.path),
      currentSessionId: props.sessionId,
      statusFor: (sessionId: string) => props.api.state.session.status(sessionId),
    })
  })
  const colors = () => props.api.theme.current
  const navigate = (sessionId: string) => props.api.route.navigate("session", { sessionID: sessionId })

  return (
    <Show when={panel()?.members?.length}>
      <box flexDirection="column" gap={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={colors().text}><b>Team</b></text>
          <text fg={colors().textMuted}>{panel()!.taskId}</text>
        </box>
        <Show when={panel()!.leadSessionId !== props.sessionId}>
          <box onMouseDown={() => navigate(panel()!.leadSessionId)}>
            <text fg={colors().accent}>← Lead</text>
          </box>
        </Show>
        <For each={panel()!.members}>{(member: any) => {
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
