// The Guided Setup tab: a column of panels, each owning its own state and
// taking no props.
//
// The onboarding screen — the worker-group picker, the pack's status rows,
// every pack write's confirmation, the step log, and the endpoint the pack's
// source listens on — is <OnboardingPanel>. What stays in this file is the part
// with no state at all: a reference list of what onboarding creates and what to
// know before running it, and the order of the panels below it.
//
// *(Corrected 2026-09-26, `chore/remove-global-stacks`: <ProvisionPanel>, the
// Remove of the global Raw HTTP and Syslog stacks earlier releases created,
// sat under <OnboardingPanel> while one of their objects was in the group.
// Owner decision: new installs never have those stacks, so the panel is gone;
// a tenant that still holds them keeps them, orphaned.)*

import { Suspense } from 'react'
import { AccelPanel } from '../components/AccelPanel'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { lazyTab } from '../app/lazyTab'
import { MetricsStorePanel } from '../components/MetricsStorePanel'
import { OnboardingPanel } from '../components/OnboardingPanel'
import { LakeLandingPanel } from '../components/LakeLandingPanel'
// The anchor id lives beside the panel's other pure constants, not in the
// component file — src/components/lakeLandingCopy.ts.
import { INGEST_ANCHOR_ID } from '../components/lakeLandingCopy'
import { Panel } from '../components/Panel'
import { SearchLimitsPanel } from '../components/SearchLimitsPanel'
import { InfoTip } from '../components/InfoTip'
import { PACK_SETUP_FACTS } from '../components/provisionPanelCopy'

// The store benchmark is its own chunk. It is the page's rarest tool, and in
// Guided Setup's chunk it added 21.9 kB raw (227.6 -> 249.5 kB, over the 243 kB
// lazy-chunk budget) for every visit to this page; split, the page paints
// without it and it arrives a moment later at the bottom. A chunk that fails
// to load shows <ErrorBoundary>'s Reload message in its place, never a blank.
const BenchmarkPanel = lazyTab(() => import('../components/BenchmarkPanel'), 'BenchmarkPanel')

export function GuidedSetup() {
  // "What gets created" names the pack's objects: the pack is the only
  // onboarding (2026-09-25), whatever the pinned release says.
  const facts = PACK_SETUP_FACTS
  return (
    <div className="tab">
      {/* The page's heading, as every other tab has one. No sub-line: each
          panel below carries its own one-line lead. */}
      <div className="tab-intro">
        <h2 className="tab-h">Guided setup</h2>
      </div>
      {/* The wrapper exists for one reason: <LakeLandingPanel>'s dataset-absent
          state has to point somewhere, and the four-section shell that would
          have given it a `/setup/ingest` route was withdrawn on 2026-09-17
          (I-D2). So it points here, in this page, and the id lives beside the
          link that uses it rather than as a string typed twice. A plain <div> in
          a `.tab` flex column is one flex item wrapping one panel; it changes
          nothing about the layout. */}
      <div id={INGEST_ANCHOR_ID}>
        {/* The pack's onboarding — the only one. It reads the page's one
            worker group (useSetupGroup) and one run lock
            (cribl/setupRunLock.ts), which every panel here that writes shares,
            so no two of them name two groups or commit over each other. */}
        <OnboardingPanel />
      </div>

      {/* Five short labels, each with its explanation behind an ⓘ. The words
          are provisionPanelCopy.ts's `PACK_SETUP_FACTS`. */}
      <Panel title="What gets created & things to know">
        <ul className="gs-facts">
          {facts.map((fact) => (
            <li key={fact.label}>
              {fact.label}
              <InfoTip text={fact.tip} />
            </li>
          ))}
        </ul>
      </Panel>

      {/* Where the data lands once the stack above is delivering it, and the
          three things about that a customer may change. It sits directly under
          the ingest panel and the notes that explain it, because "what did I
          just create" and "how is it landing" are one question asked twice, and
          because its dataset-absent state links back UP to the panel above it —
          with the four-section shell withdrawn (I-D2) there is nowhere else to
          send anybody. Above <SearchLimitsPanel> and <AccelPanel> for the same
          reason those two are in the order they are: this one is about the data
          itself, and the two below are about what reading it is allowed to cost.
          It takes no props and owns all of its own state. */}
      <LakeLandingPanel />

      {/* The one install-wide setting the app has. It lives here because this
          is the tab an installer already opens to set the workspace up, and
          because raising a cap is the same kind of act as provisioning: it
          changes what every viewer of this install gets, not just this one. */}
      <SearchLimitsPanel />

      {/* Section 3. The second place this app writes Cribl configuration, and
          it is on this tab for the reason above and one more: the two objects
          it creates run on a cron and bill whether or not anybody opens the app,
          so the person who has to be told they exist is the installer, not a
          viewer of Data Flow. It is BELOW <SearchLimitsPanel> deliberately —
          the running-time caps decide what a live query is allowed to cost, and
          the argument for scheduling one is easier to read after that number
          than before it. Everything it holds is its own; it takes no props, and
          nothing above reads anything it knows. */}
      <AccelPanel />

      {/* Section 4, and LAST for the same reason <AccelPanel> is third: the
          panels on this page descend from "what exists" to "what it costs to
          read" to "what runs on a cron whether or not anybody is here". A
          metrics store is the furthest along that line — it would publish
          continuously — so it sits at the bottom.

          It REPORTS ONLY. Nothing publishes metrics yet, and this card exists
          so an installer can see whether the workspace could hold them without
          going to look in Cribl Search. It is also the one card on this page
          that is not about making the dashboards faster: a metrics store serves
          long-term retention and alerting, and the panels it could serve are
          already served by the scheduled snapshots above it. */}
      <MetricsStorePanel />

      {/* Section 5, the store benchmark. An install-level tool rather than a
          dashboard: whoever decides which Cribl Lake copy the dashboards may
          read is the installer, and this page already hosts the install-wide
          tools. It is last because it runs nothing on its own — every search
          it submits starts from a confirmed click — and it changes nothing about
          the install; results live on this page until it is left.
          components/BenchmarkPanel.tsx carries the rest of the argument. */}
      <ErrorBoundary>
        <Suspense fallback={null}>
          <BenchmarkPanel />
        </Suspense>
      </ErrorBoundary>

      {/* The toast stack that used to be rendered here now lives at the app root
          and is Capra's — an `aria-live` container that appeared together with
          its first message was announcing a failed deploy by luck, and a toast
          about a write should outlive a route change anyway.
          src/components/Toast.tsx carries the argument. `pushToast` is the same
          call it always was. */}
    </div>
  )
}
