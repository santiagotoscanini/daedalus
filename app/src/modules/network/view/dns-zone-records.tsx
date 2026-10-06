import { Board, Chip, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, since } from '../../../lib/format'
import { RecordList } from './dns-records'
import type { Zone } from './dns-zone'
import { CAPTION, EMPTY, FOOT, MAIN, MONO, N, NOTE, ROW, SIDE } from './shared'

/** Each mail domain's posture, with the records it was read from. */
export function MailRecords({ d }: { d: Zone }) {
  // What the mail board is a reading OF: the zone's count less the names,
  // elsewhere and leftovers groups. `unclassified` is not subtracted, so this
  // equals `tally.mail` only while that group is empty.
  const mailRecords =
    d.cf.records === null
      ? 0
      : d.cf.records - d.names.length - d.elsewhere.length - d.leftovers.length

  return (
    <Board
      title="Mail"
      icon="✉"
      span={6}
      aside={<span className={NOTE}>{d.mail.length} domains</span>}
    >
      {d.mail.length === 0 ? (
        <p className={EMPTY}>no MX records in this zone</p>
      ) : (
        d.mail.map((m) => (
          // One block per mail domain: the name and its MX on a line, the
          // four verdicts under it. Two domains fit a half-width board
          // without either one wrapping.
          <section key={m.domain} className="not-first:mt-4">
            {/* Not the board's own heading style: that one is uppercased,
                    and a domain name and its mail exchangers are literal
                    strings that are wrong in capitals. */}
            <h4 className={cn(MONO, 'm-0 text-[0.8rem] text-foreground [font-weight:560]')}>
              {m.domain}
            </h4>
            {/* The exchangers are the answer to "who receives this", so
                    they belong under the name — but they are three words of
                    context, not a heading. */}
            <p className={cn(MONO, 'mx-0 mt-0.5 mb-2 text-[0.72rem] text-muted-foreground')}>
              {m.mx.join(' · ') || 'no MX'}
            </p>
            <Measures
              items={[
                {
                  k: 'SPF',
                  v: m.spf === null ? 'missing' : (m.spf.include[0] ?? 'set'),
                  tone: m.spf === null ? 'bad' : 'ok',
                },
                {
                  k: 'DKIM',
                  v:
                    m.dkim === 0
                      ? 'missing'
                      : `${String(m.dkim)} selector${m.dkim === 1 ? '' : 's'}`,
                  tone: m.dkim === 0 ? 'bad' : 'ok',
                },
                {
                  k: 'DMARC',
                  v: m.dmarc === null ? 'missing' : (m.dmarc.policy ?? 'set'),
                  tone: m.dmarc === null ? 'bad' : m.dmarc.policy === 'reject' ? 'ok' : 'info',
                },
                {
                  k: 'Forgeries',
                  v:
                    m.spf === null
                      ? 'unchecked'
                      : m.spf.qualifier === '-'
                        ? 'rejected'
                        : 'accepted, marked',
                  tone: m.spf?.qualifier === '-' ? 'ok' : 'info',
                },
              ]}
            />
            <RecordList
              records={m.records}
              summary={`The ${String(m.records.length)} records`}
              note="MX says who receives it, SPF which servers may send as this domain, the _domainkey selectors carry the signing keys, and _dmarc says what a receiver should do when neither of the first two holds."
            />
          </section>
        ))
      )}
      <p className={FOOT}>
        The {mailRecords} records behind this read as one policy: SPF says which servers may send as
        this domain, DKIM signs what they send, DMARC says what a receiver should do when neither
        holds. <b>quarantine</b> means spam folder rather than bounce, and <b>accepted, marked</b>{' '}
        is an SPF ending in <span className={MONO}>~all</span>, so a forgery is flagged rather than
        refused. Both are the cautious settings, and both are worth tightening once nothing
        legitimate is being caught by them. Open a domain to check the reading against the records
        it came from.
      </p>
    </Board>
  )
}

/** Every record the other boards did not claim, in folded groups, with the tally. */
export function RestOfZone({ d }: { d: Zone }) {
  return (
    <Board
      title="The rest of the zone"
      icon="logs"
      span={6}
      aside={
        d.leftovers.length > 0 ? (
          <Chip tone="warn">{d.leftovers.length} leftover</Chip>
        ) : (
          <span className={NOTE}>{d.elsewhere.length} records</span>
        )
      }
    >
      <RecordList
        records={d.elsewhere}
        summary="Pointed somewhere else"
        note="Names in this zone served by someone other than this box: a static site host, a CDN, and the verification records those asked for."
        open
      />
      <RecordList
        records={d.leftovers}
        summary="Leftovers"
        tone="warn"
        note="An _acme-challenge TXT is written during a certificate issuance and deleted when it finishes, so every one still in the zone belongs to an issuance that did not clean up. It proves nothing and grants nothing. Two pairs of them are also the same value entered twice, once quoted and once not."
      />
      <RecordList
        records={d.unclassified}
        summary="Everything else"
        tone="bad"
        note="Records none of the groups on this page claimed. The groups are rules: has an MX, is an _acme-challenge, points at the tunnel. Anything a rule set does not cover belongs here rather than nowhere."
        open
      />

      <p className={CAPTION}>
        {d.tally.total === null ? (
          'The zone could not be read.'
        ) : (
          <>
            All {d.tally.total} records in the zone are on this page: {d.tally.house} pointing back
            here, {d.tally.mail} for mail, {d.tally.elsewhere} pointed elsewhere and{' '}
            {/* The tail is ONE expression on ONE line: JSX turns a newline
                    before an interpolation into a space, so splitting this
                    left the sentence ending in " ." */}
            {`${String(d.tally.leftovers)} left over${d.tally.unclassified > 0 ? `, plus ${String(d.tally.unclassified)} unclassified` : ''}.`}{' '}
          </>
        )}
      </p>
      {d.tally.total !== null && (
        <p className={FOOT}>
          The count is Cloudflare’s and the groups are computed from it, so a record that stopped
          matching its rule shows up above rather than going missing.
        </p>
      )}
    </Board>
  )
}

/** The zone keeps no log, so this is when — never what or who. */
export function RecentlyChanged({ d }: { d: Zone }) {
  return (
    <Board
      title="Recently changed"
      icon="◴"
      span={12}
      aside={<span className={NOTE}>the zone keeps no log</span>}
    >
      {/* Two-up on a full-width board, since these rows are short. 34rem
              rather than 24: at 24 the target column had nothing left after the
              name and the age, so every name truncated to four characters and
              "3d ago" wrapped onto two lines. A column that cannot hold its
              content is not a column. */}
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(34rem,1fr))] gap-x-[0.6rem] gap-y-[0.22rem] p-0">
        {d.changed.map((r) => (
          // Fixed tracks, so the name always gets its width and the target
          // gives: the name is what identifies the row, the target is
          // context.
          <li
            key={`${r.fqdn}-${r.type}-${r.content}`}
            className={cn(ROW, 'grid grid-cols-[minmax(6rem,9rem)_3.4rem_1fr_auto] gap-[0.4rem]')}
          >
            <span className={cn(MAIN, MONO)}>{r.short}</span>
            <Chip tone="muted">{r.type}</Chip>
            <span className={cn(MONO, SIDE, 'max-w-none flex-auto text-left opacity-85')}>
              {r.content}
            </span>
            <span className={cn(N, 'whitespace-nowrap')}>
              {r.changedAgo === null ? DASH : since(r.changedAgo)}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        The six most recently edited records. Cloudflare stamps every record with when it last
        changed but keeps no history of what it changed from, so this says when, never what and
        never who.
      </p>
    </Board>
  )
}
