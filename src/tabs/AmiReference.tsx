import { Panel } from '../components/Panel'

interface DocRef {
  title: string
  url: string
  note: string
}

const DOCS: DocRef[] = [
  { title: 'Application Metadata Intelligence — Product', url: 'https://www.gigamon.com/products/optimize-traffic/application-intelligence/application-metadata.html', note: 'Overview, benefits, and where AMI fits in the deep-observability pipeline.' },
  { title: 'AMI — Gigamon Documentation Library', url: 'https://docs.gigamon.com/ami/Content/GV-GigaSMART/Application%20Metadata%20Intelligence.html', note: 'GigaSMART configuration; export formats (IPFIX / CEF), AMX (CEF→JSON).' },
  { title: 'Application Metadata Intelligence — Datasheet', url: 'https://www.gigamon.com/content/dam/resource-library/english/data-sheet/ds-application-aware-metadata.pdf', note: 'Attribute counts, supported apps, and use-case summary.' },
  { title: 'What is Application Metadata (and why it matters)', url: 'https://blog.gigamon.com/2019/11/20/what-is-application-metadata-and-why-does-it-matter/', note: 'Plain-language intro to app metadata vs. raw packets.' },
]

const FAMILIES: { name: string; desc: string; fields: string }[] = [
  { name: 'Core 5-tuple + identity', desc: 'Every record: L3/L4 endpoints, app, timing.', fields: 'src_ip dst_ip src_port dst_port protocol src_mac dst_mac app_name app_id start_time end_time' },
  { name: 'DNS', desc: 'Query/response metadata — the strongest signal in this feed.', fields: 'dns_query dns_host dns_reply_code dns_response_time dns_name dns_host_addr' },
  { name: 'SNMP', desc: 'Management-plane visibility incl. processing anomalies.', fields: 'snmp_method snmp_version snmp_oid snmp_community snmp_processing_anomaly_*' },
  { name: 'SSL / TLS', desc: 'Handshake, cipher, and certificate posture.', fields: 'ssl_server_name ssl_issuer ssl_validity_not_after ssl_protocol_version ssl_cipher_suite_id' },
  { name: 'HTTP / HTTP2', desc: 'Request/response headers, URIs, status.', fields: 'http_host http_uri http_method http_code http_user_agent http2_*' },
  { name: 'TCP metrics', desc: 'Latency and wire-error counters.', fields: 'tcp_rtt tcp_rtt_app tcp_dup_ack tcp_wrong_crc tcp_loss_count tcp_flags' },
  { name: 'Cloud enrichment (AWS)', desc: 'Per-endpoint instance, VPC, tags, security groups.', fields: 'src_aws_instance_id dst_aws_vpc_id *_aws_tags *_aws_security_group_name' },
  { name: 'Other protocols', desc: 'SSH, RTP, DHCP, NTP, ICMP, Kerberos, DCE/RPC.', fields: 'ssh_* rtp_* dhcp_* ntp_* icmp_* krb5_* dcerpc_*' },
]

export function AmiReference() {
  return (
    <div className="tab">
      <div className="tab-intro">
        <h2 className="tab-h">Gigamon AMI — learn the data</h2>
        <p className="tab-sub">
          Application Metadata Intelligence (AMI) is a GigaSMART application that extracts rich application-layer
          metadata from network traffic — up to ~6,000 attributes across 4,000+ applications, with no agents on
          the workloads. Metadata is exported as IPFIX or CEF; the Application Metadata Exporter (AMX) converts CEF
          to JSON. The records in this app are AMX JSON (<code>vendor:"Gigamon"</code>, <code>version:"6.13.00"</code>).
        </p>
      </div>

      <Panel title="Metadata families in this feed" note="~300 distinct fields observed">
        <div className="fam-grid">
          {FAMILIES.map((f) => (
            <div className="fam" key={f.name}>
              <div className="fam-name">{f.name}</div>
              <div className="fam-desc">{f.desc}</div>
              <div className="fam-fields"><code>{f.fields}</code></div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="What AMI is used for">
          <ul className="usecases">
            <li><strong>Network performance:</strong> latency decomposition (network vs. app vs. DNS), error/resource codes, top talkers.</li>
            <li><strong>Security &amp; threat detection:</strong> C2 identification, weak ciphers, expired / unknown-CA certificates, shadow-AI/SaaS discovery via <code>app_name</code>.</li>
            <li><strong>Operational technology:</strong> isolating machine-to-machine traffic (HL7, SCADA, OpenRTB).</li>
            <li><strong>Analytics offload:</strong> ~90% smaller than full packets while keeping the fields tools need.</li>
          </ul>
        </Panel>

        <Panel title="Documentation">
          <ul className="doclist">
            {DOCS.map((d) => (
              <li key={d.url}>
                <a href={d.url} target="_blank" rel="noreferrer" className="doclink">{d.title} ↗</a>
                <span className="docnote">{d.note}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}
