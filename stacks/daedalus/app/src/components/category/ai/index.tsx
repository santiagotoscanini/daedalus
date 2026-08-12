import type { AiData } from '../../../lib/dashboard/categories/ai'
import { LemonadeView } from './lemonade'
import { LitellmView } from './litellm'
import { N8nView } from './n8n'
import { OpenWebUiView } from './open-webui'

// The AI pages — one per service, chosen by the sub-tab.
//
// Every one of them opens the same way, and that is deliberate: artwork, name,
// the version running, the verdict on whether that version is current, one
// sentence saying where this service sits in the chain, and the link you came
// to click. Four services whose UIs look nothing alike become four pages that
// are read the same way.
//
// Underneath, each is its own thing. Lemonade's page is about VRAM and what is
// resident; LiteLLM's is about traffic and routing; the two caller pages are
// mostly "is it configured the way I think it is". Forcing those into a shared
// layout is what the previous single-page version did, and it is why every
// service got a quarter of a row it could not say anything useful in.
//
// No `StatBand`/`BigStat` anywhere on these four pages any more: every one of
// them ended up saying either a number the panel below it states in context,
// or a number that is zero almost always and means nothing when it is not.

export function AiView({ data }: { data: AiData }) {
  switch (data.tab) {
    case 'lemonade':
      return <LemonadeView data={data} />
    case 'litellm':
      return <LitellmView data={data} />
    case 'open-webui':
      return <OpenWebUiView data={data} />
    case 'n8n':
      return <N8nView data={data} />
  }
}
