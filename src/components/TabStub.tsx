interface TabStubProps {
  title: string
  intro: string
  planned: string[]
  fields?: string[]
  gap?: string
}

/** Placeholder for tabs still being built out — shows intent, planned panels,
 *  the AMI fields they'll use, and any honest data gap. */
export function TabStub({ title, intro, planned, fields, gap }: TabStubProps) {
  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">{title}</h2>
        <p className="tab-sub">{intro}</p>
      </div>
      <section className="panel stub-panel">
        <div className="stub-badge">Building next</div>
        <h3 className="panel-title">Planned panels</h3>
        <ul className="stub-list">
          {planned.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {fields && (
          <>
            <h3 className="panel-title">AMI fields used</h3>
            <div className="chip-row">
              {fields.map((f) => (
                <code className="fieldchip" key={f}>{f}</code>
              ))}
            </div>
          </>
        )}
        {gap && (
          <p className="stub-gap">
            <strong>Honest gap:</strong> {gap}
          </p>
        )}
      </section>
    </div>
  )
}
