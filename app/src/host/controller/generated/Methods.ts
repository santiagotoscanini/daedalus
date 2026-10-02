// Generated from agent/src (src/ts.rs). Do not edit: change the Rust type,
// then run agent/gate.sh gen.

import type { ActionOutcome } from './ActionOutcome'
import type { ActionQueryParams } from './ActionQueryParams'
import type { ClaudeRosterGet } from './ClaudeRosterGet'
import type { ClaudeSessionParams } from './ClaudeSessionParams'
import type { ClaudeSessionSent } from './ClaudeSessionSent'
import type { ClaudeStatus } from './ClaudeStatus'
import type { CommandOk } from './CommandOk'
import type { ControllerInfo } from './ControllerInfo'
import type { ControllerRotateParams } from './ControllerRotateParams'
import type { HelloOk } from './HelloOk'
import type { HelloParams } from './HelloParams'
import type { NodeClaudeOk } from './NodeClaudeOk'
import type { NodeClaudeRosterOk } from './NodeClaudeRosterOk'
import type { NodeClaudeSessionParams } from './NodeClaudeSessionParams'
import type { NodeCommandParams } from './NodeCommandParams'
import type { NodeDetail } from './NodeDetail'
import type { NodeGetParams } from './NodeGetParams'
import type { NodeIdParams } from './NodeIdParams'
import type { NodeProviderInstallParams } from './NodeProviderInstallParams'
import type { NodeProviderModelParams } from './NodeProviderModelParams'
import type { NodeProviderPowerParams } from './NodeProviderPowerParams'
import type { NodeProvidersOk } from './NodeProvidersOk'
import type { NodesList } from './NodesList'
import type { ProviderInstallSent } from './ProviderInstallSent'
import type { ProviderModelSent } from './ProviderModelSent'
import type { ProviderPowerSent } from './ProviderPowerSent'
import type { Queued } from './Queued'
import type { RootFollowOk } from './RootFollowOk'
import type { RootFollowParams } from './RootFollowParams'
import type { RootRunOk } from './RootRunOk'
import type { RootRunParams } from './RootRunParams'
import type { RootRunsOk } from './RootRunsOk'
import type { RootRunsParams } from './RootRunsParams'
import type { SantreeStatus } from './SantreeStatus'
import type { SessionQueued } from './SessionQueued'
import type { SetDesired } from './SetDesired'
import type { SetDesiredOk } from './SetDesiredOk'
import type { Subscribed } from './Subscribed'
import type { SystemInfo } from './SystemInfo'
import type { TelemetryGet } from './TelemetryGet'

/** Each method of the controller's API: its parameters (null: it takes none) and its answer. */
export type Methods = {
  'hello': [HelloParams, HelloOk]
  'events.subscribe': [null, Subscribed]
  'system.info': [null, SystemInfo]
  'claude.status': [null, ClaudeStatus]
  'claude.restart': [null, Queued]
  'claude.roster': [null, ClaudeRosterGet]
  'claude.session': [ClaudeSessionParams, SessionQueued]
  'telemetry.get': [null, TelemetryGet]
  'actions.get': [ActionQueryParams, ActionOutcome | null]
  'nodes.list': [null, NodesList]
  'nodes.get': [NodeGetParams, NodeDetail]
  'nodes.providers': [NodeIdParams, NodeProvidersOk]
  'nodes.claude': [NodeIdParams, NodeClaudeOk]
  'nodes.claude_roster': [NodeIdParams, NodeClaudeRosterOk]
  'nodes.claude_session': [NodeClaudeSessionParams, ClaudeSessionSent]
  'nodes.provider_model': [NodeProviderModelParams, ProviderModelSent]
  'nodes.provider_install': [NodeProviderInstallParams, ProviderInstallSent]
  'nodes.provider_power': [NodeProviderPowerParams, ProviderPowerSent]
  'nodes.set_desired': [SetDesired, SetDesiredOk]
  'nodes.command': [NodeCommandParams, CommandOk]
  'controller.rotate': [ControllerRotateParams, ControllerInfo]
  'root.run': [RootRunParams, RootRunOk]
  'root.follow': [RootFollowParams, RootFollowOk]
  'root.runs': [RootRunsParams, RootRunsOk]
  'santree.status': [null, SantreeStatus]
}
