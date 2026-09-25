// The app-level "sample data" banner — one source for the <AppBanners> slot.
//
// Info, not warning: nothing is wrong and nothing needs doing. It cannot be
// dismissed, because it is not a message about something that happened but a
// description of every number on the page for as long as it stays true; it
// goes away by itself the moment the app moves back to real data.

import type { AppBanner } from './AppBanners'
import { InfoTip } from './InfoTip'
import { SAMPLE_TIP, SAMPLE_TITLE, sampleBody } from './sampleDataCopy'
import { useDatasetTarget } from '../cribl/datasetTarget'

export function useSampleDataBanner(): AppBanner | null {
  const target = useDatasetTarget()
  if (!target.sample) return null
  return {
    id: 'sample-data',
    appearance: 'info',
    title: SAMPLE_TITLE,
    body: (
      <>
        {sampleBody(target)} <InfoTip text={SAMPLE_TIP} side="bottom" />
      </>
    ),
  }
}
