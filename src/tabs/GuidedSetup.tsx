// What is left of the Guided Setup tab once the half that writes moved out.
//
// The provisioning screen — the worker-group picker, the resource checklist,
// both write confirmations, the step log, and the endpoint a deployed stack
// listens on — is <ProvisionPanel>. It owns all of that state and takes no
// props. src/components/ProvisionPanel.tsx carries the argument for why the
// seam falls there and not somewhere that would have left this file in charge;
// the short version is that every value it holds is read by at least two of the
// things it draws, and not one of them is read by anything below.
//
// What stayed is the part with no state at all: a reference list of what a
// deploy creates and what to know before running one, and the single
// install-wide search setting that shares this page because an installer is
// already standing on it — not because it has anything to do with setup.

import { AccelPanel } from '../components/AccelPanel'
import { MetricsStorePanel } from '../components/MetricsStorePanel'
import { OnboardingPanel } from '../components/OnboardingPanel'
import { LakeLandingPanel } from '../components/LakeLandingPanel'
// The anchor id lives beside the panel's other pure constants, not in the
// component file — src/components/lakeLandingCopy.ts.
import { INGEST_ANCHOR_ID } from '../components/lakeLandingCopy'
import { Panel } from '../components/Panel'
import { ProvisionPanel } from '../components/ProvisionPanel'
import { SearchLimitsPanel } from '../components/SearchLimitsPanel'
import { InfoTip } from '../components/InfoTip'
import { setupFacts } from '../components/provisionPanelCopy'
import { onboardingPath } from '../cribl/onboarding/plan'
import { packRelease } from '../cribl/pack'

export function GuidedSetup() {
  // Which onboarding the page offers decides which objects "What gets created"
  // names: the pack's once its release can be installed, the global Raw HTTP
  // stack's until then. Pure: `packRelease()` reads this build's constants and
  // no presence is needed to pick the list.
  const facts = setupFacts(onboardingPath(packRelease(), null).mode)
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
        {/* The pack's onboarding first, then the Raw HTTP stack's panel. Which
            of the two IS the onboarding is onboarding/plan.ts
            `onboardingPath`: the Raw HTTP stack's until this build's pack
            release can be installed, and then the pack's, with the Raw HTTP
            panel reduced to Remove while its stack is in the group. Both read
            one worker group (useSetupGroup) and one run lock
            (cribl/setupRunLock.ts), so they cannot name two groups or commit
            over each other. */}
        <OnboardingPanel />
        <ProvisionPanel />
      </div>

      {/* Five short labels, each with its explanation behind an ⓘ. The words
          are provisionPanelCopy.ts's, beside the rest of this stack's copy,
          and which five follows the onboarding path above. */}
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

      {/* The toast stack that used to be rendered here now lives at the app root
          and is Capra's — an `aria-live` container that appeared together with
          its first message was announcing a failed deploy by luck, and a toast
          about a write should outlive a route change anyway.
          src/components/Toast.tsx carries the argument. `pushToast` is the same
          call it always was. */}
    </div>
  )
}
