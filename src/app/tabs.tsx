// The tab list: route, label, element. Adding a tab is one entry here.
//
// ONE TAB IS EAGER: the landing route. `/` and every unknown route redirect to
// it (src/App.tsx), so it is what first paint is waiting for, and a lazy chunk
// there would add a round trip to the one load that matters most. Every other
// tab is its own chunk, loaded the first time someone opens it — see
// src/app/lazyTab.ts for why, and for the failure path.
//
// If LANDING_ROUTE ever changes, change which import below is static with it;
// src/app/tabs.test.tsx fails if the landing tab is lazy.

import type { ReactElement } from 'react'
import { FlowMap } from '../tabs/FlowMap'
import { lazyTab } from './lazyTab'

export const LANDING_ROUTE = '/flow-map'

const Findings = lazyTab(() => import('../tabs/Findings'), 'Findings')
const Security = lazyTab(() => import('../tabs/Security'), 'Security')
const CapacityTopTalkers = lazyTab(() => import('../tabs/CapacityTopTalkers'), 'CapacityTopTalkers')
const TcpHealth = lazyTab(() => import('../tabs/TcpHealth'), 'TcpHealth')
const DnsHealth = lazyTab(() => import('../tabs/DnsHealth'), 'DnsHealth')
const WebApiHealth = lazyTab(() => import('../tabs/WebApiHealth'), 'WebApiHealth')
const TlsPosture = lazyTab(() => import('../tabs/TlsPosture'), 'TlsPosture')
const PqcReadiness = lazyTab(() => import('../tabs/PqcReadiness'), 'PqcReadiness')
const ShadowAi = lazyTab(() => import('../tabs/ShadowAi'), 'ShadowAi')
const DataFlow = lazyTab(() => import('../tabs/DataFlow'), 'DataFlow')
const FieldExplorer = lazyTab(() => import('../tabs/FieldExplorer'), 'FieldExplorer')
const AmiReference = lazyTab(() => import('../tabs/AmiReference'), 'AmiReference')
const GuidedSetup = lazyTab(() => import('../tabs/GuidedSetup'), 'GuidedSetup')

export interface TabDef {
  to: string
  label: string
  el: ReactElement
}

export const TABS: readonly TabDef[] = [
  { to: '/findings', label: 'Findings', el: <Findings /> },
  { to: '/security', label: 'Security', el: <Security /> },
  { to: LANDING_ROUTE, label: 'Flow Map', el: <FlowMap /> },
  { to: '/capacity', label: 'Capacity & Top Talkers', el: <CapacityTopTalkers /> },
  { to: '/tcp-health', label: 'TCP Health', el: <TcpHealth /> },
  { to: '/dns-health', label: 'DNS Health', el: <DnsHealth /> },
  { to: '/web-api', label: 'Web & API', el: <WebApiHealth /> },
  { to: '/tls-posture', label: 'TLS Posture', el: <TlsPosture /> },
  { to: '/pqc', label: 'PQC Readiness', el: <PqcReadiness /> },
  { to: '/ai-saas', label: 'Shadow AI', el: <ShadowAi /> },
  { to: '/data-flow', label: 'Data Flow', el: <DataFlow /> },
  { to: '/fields', label: 'Field Explorer', el: <FieldExplorer /> },
  { to: '/reference', label: 'AMI Reference', el: <AmiReference /> },
  { to: '/setup', label: 'Guided Setup', el: <GuidedSetup /> },
]
