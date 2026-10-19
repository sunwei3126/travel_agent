import type {
  Claim,
  DayBlock,
  DayCard as DayCardData,
} from "@pi-demo/shared";
import type { CSSProperties } from "react";

const CARD_STYLE: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1rem",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
};

const CLAIM_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.25rem",
};

const BLOCK_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.6rem",
};

export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function ClaimItem({ claim }: { claim: Claim }) {
  const unverified = claim.kind === "fact" && claim.unverified === true;

  return (
    <li className="claim">
      <span>{claim.text}</span>
      {unverified && <span className="claim-unverified">未核实</span>}
    </li>
  );
}

function ClaimList({ claims }: { claims: Claim[] }) {
  return (
    <ul style={CLAIM_LIST_STYLE}>
      {claims.map((claim, index) => (
        <ClaimItem key={`${claim.text}-${index}`} claim={claim} />
      ))}
    </ul>
  );
}

function ClaimGroup({ label, claims }: { label: string; claims: Claim[] }) {
  if (claims.length === 0) {
    return null;
  }

  return (
    <section className="claim-group">
      <h3>{label}</h3>
      <ClaimList claims={claims} />
    </section>
  );
}

function BlockItem({ block }: { block: DayBlock }) {
  return (
    <li className="day-block">
      <span className="day-block-time">{block.time}</span>
      <div>
        <strong>{block.title}</strong>
        {block.detail !== "" && <p className="day-block-detail">{block.detail}</p>}
        {block.claims.length > 0 && <ClaimList claims={block.claims} />}
        {block.costCny !== undefined && (
          <p className="day-block-cost">
            {`¥${block.costCny[0]}–¥${block.costCny[1]}`}
          </p>
        )}
      </div>
    </li>
  );
}

export function DayCard({
  card,
  justUpdated = false,
}: {
  card: DayCardData;
  justUpdated?: boolean;
}) {
  return (
    <article className="day-card" data-testid="day-card" style={CARD_STYLE}>
      <header className="day-card-header">
        <h2>{card.title}</h2>
        <p className="day-card-meta">
          {`第 ${card.dayIndex} 天 · ${card.date}`}
        </p>
        {justUpdated && <span className="day-card-updated">已更新</span>}
      </header>

      {card.svg ? (
        <img
          className="day-card-svg"
          src={svgDataUrl(card.svg)}
          alt={`${card.title} 示意图`}
        />
      ) : (
        <div className="day-card-svg-placeholder">示意图待生成</div>
      )}

      {card.blocks.length > 0 && (
        <ol className="day-blocks" style={BLOCK_LIST_STYLE}>
          {card.blocks.map((block, index) => (
            <BlockItem key={`${block.time}-${index}`} block={block} />
          ))}
        </ol>
      )}

      <div className="day-card-claims">
        <ClaimGroup label="风景" claims={card.scenery} />
        <ClaimGroup label="美食" claims={card.food} />
        <ClaimGroup label="交通" claims={card.transport} />
      </div>

      <p className="day-card-cost">
        {`预估 ¥${card.estimatedCostCny[0]}–¥${card.estimatedCostCny[1]}`}
      </p>

      {card.sources.length > 0 && (
        <ul className="day-card-sources">
          {card.sources.map((source, index) => (
            <li key={`${source}-${index}`} className="source-chip">
              {source}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
