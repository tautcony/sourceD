import { useState, useMemo, useRef, useCallback } from "react";
import { Flex, Typography } from "antd";
import { fileSizeIEC, i18nMessage } from "../../shared/utils.mjs";
import { registrableDomain } from "../utils.jsx";

const { Text } = Typography;

const CHART_SIZE = 220;
const CHART_CENTER = CHART_SIZE / 2;
// Outer donut ring radii
const OUTER_R = 96;
const OUTER_INNER_R_TWO = 72; // inner edge when two rings shown
const OUTER_INNER_R_ONE = 62; // inner edge when single ring shown
// Inner donut ring radii (shown only when multiple domains)
const INNER_R = 68;
const CENTER_R = 42; // radius of the center white hole

function polarToCartesian(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * Build an SVG path for an annular (donut) sector.
 * Uses evenodd fill rule; the inner sub-path punches out the hole.
 */
function donutSlicePath(cx, cy, r1, r2, startDeg, endDeg) {
  if (endDeg - startDeg >= 360) {
    // Split into two 180° arcs to avoid degenerate single-point arc
    const tO = polarToCartesian(cx, cy, r2, 0);
    const bO = polarToCartesian(cx, cy, r2, 180);
    const tI = polarToCartesian(cx, cy, r1, 0);
    const bI = polarToCartesian(cx, cy, r1, 180);
    return [
      `M ${tO.x} ${tO.y} A ${r2} ${r2} 0 1 1 ${bO.x} ${bO.y} A ${r2} ${r2} 0 1 1 ${tO.x} ${tO.y}`,
      `M ${tI.x} ${tI.y} A ${r1} ${r1} 0 1 0 ${bI.x} ${bI.y} A ${r1} ${r1} 0 1 0 ${tI.x} ${tI.y}`,
    ].join(" ");
  }
  const os = polarToCartesian(cx, cy, r2, startDeg);
  const oe = polarToCartesian(cx, cy, r2, endDeg);
  const ie = polarToCartesian(cx, cy, r1, endDeg);
  const is_ = polarToCartesian(cx, cy, r1, startDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${os.x} ${os.y} A ${r2} ${r2} 0 ${largeArc} 1 ${oe.x} ${oe.y} L ${ie.x} ${ie.y} A ${r1} ${r1} 0 ${largeArc} 0 ${is_.x} ${is_.y} Z`;
}

function midOffset(cx, cy, rMid, startDeg, endDeg, factor = 0.07) {
  if (endDeg - startDeg >= 360) return { dx: 0, dy: 0 };
  const midDeg = (startDeg + endDeg) / 2;
  const rad = (midDeg - 90) * Math.PI / 180;
  return { dx: Math.cos(rad) * rMid * factor, dy: Math.sin(rad) * rMid * factor };
}

export default function DistributionChart({ items, colorMap = {}, onLegendClick }) {
  const [activeSiteKey, setActiveSiteKey] = useState(null);
  const legendRefs = useRef({});

  const sortedItems = useMemo(() =>
    items
      .filter((item) => item && item.siteKey)
      .slice()
      .sort((a, b) => (Number(b.byteSize) || 0) - (Number(a.byteSize) || 0)),
  [items]);

  const totalBytes = useMemo(() =>
    sortedItems.reduce((sum, item) => sum + (Number(item.byteSize) || 0), 0),
  [sortedItems]);

  // Domain order: eTLD+1 sorted by aggregated byteSize descending
  const domainOrder = useMemo(() => {
    const totals = new Map();
    sortedItems.forEach((item) => {
      const rd = registrableDomain(item.siteKey);
      totals.set(rd, (totals.get(rd) || 0) + (Number(item.byteSize) || 0));
    });
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d);
  }, [sortedItems]);

  const showInnerRing = domainOrder.length > 1;

  // Inner ring: one slice per eTLD+1 domain
  const innerStops = useMemo(() => {
    if (!showInnerRing) return [];
    const domainData = new Map();
    sortedItems.forEach((item) => {
      const rd = registrableDomain(item.siteKey);
      if (!domainData.has(rd)) domainData.set(rd, { byteSize: 0, versionCount: 0, mapCount: 0 });
      const d = domainData.get(rd);
      d.byteSize += Number(item.byteSize) || 0;
      d.versionCount += Number(item.versionCount) || 0;
      d.mapCount += Number(item.mapCount) || 0;
    });
    const total = totalBytes > 0 ? totalBytes : sortedItems.length;
    let offset = 0;
    return domainOrder.map((domain) => {
      const d = domainData.get(domain) || { byteSize: 0, versionCount: 0, mapCount: 0 };
      const weight = totalBytes > 0 ? d.byteSize : 1;
      const nextOffset = offset + (weight / total) * 360;
      const stop = {
        domain,
        ...d,
        color: colorMap[domain] || "#8c8c8c",
        from: offset,
        to: nextOffset,
        offset: midOffset(CHART_CENTER, CHART_CENTER, (INNER_R + CENTER_R) / 2, offset, nextOffset),
        path: donutSlicePath(CHART_CENTER, CHART_CENTER, CENTER_R, INNER_R, offset, nextOffset),
      };
      offset = nextOffset;
      return stop;
    });
  }, [sortedItems, totalBytes, domainOrder, colorMap, showInnerRing]);

  // Outer ring: individual siteKeys, grouped by domain order so segments align with inner ring
  const outerStops = useMemo(() => {
    if (!sortedItems.length) return [];
    const grouped = new Map(domainOrder.map((d) => [d, []]));
    sortedItems.forEach((item) => {
      const rd = registrableDomain(item.siteKey);
      if (grouped.has(rd)) grouped.get(rd).push(item);
    });
    const ordered = domainOrder.flatMap((d) =>
      (grouped.get(d) || []).sort((a, b) => (Number(b.byteSize) || 0) - (Number(a.byteSize) || 0)),
    );
    const outerInnerR = showInnerRing ? OUTER_INNER_R_TWO : OUTER_INNER_R_ONE;
    const total = totalBytes > 0 ? totalBytes : ordered.length;
    let offset = 0;
    return ordered.map((item) => {
      const weight = totalBytes > 0 ? (Number(item.byteSize) || 0) : 1;
      const nextOffset = offset + (weight / total) * 360;
      const stop = {
        ...item,
        color: colorMap[item.siteKey] || colorMap[registrableDomain(item.siteKey)] || "#8c8c8c",
        from: offset,
        to: nextOffset,
        percent: totalBytes > 0 ? ((Number(item.byteSize) || 0) / totalBytes) * 100 : 0,
        offset: midOffset(CHART_CENTER, CHART_CENTER, (OUTER_R + outerInnerR) / 2, offset, nextOffset),
        path: donutSlicePath(CHART_CENTER, CHART_CENTER, outerInnerR, OUTER_R, offset, nextOffset),
      };
      offset = nextOffset;
      return stop;
    });
  }, [sortedItems, totalBytes, domainOrder, colorMap, showInnerRing]);

  const activeDomain = useMemo(() =>
    activeSiteKey ? registrableDomain(activeSiteKey) : null,
  [activeSiteKey]);

  const handleOuterClick = useCallback((siteKey) => {
    setActiveSiteKey((prev) => prev === siteKey ? null : siteKey);
    const ref = legendRefs.current[siteKey];
    if (ref) ref.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const handleInnerClick = useCallback((domain) => {
    setActiveSiteKey((prev) => {
      if (prev && registrableDomain(prev) === domain) return null;
      return outerStops.find((s) => registrableDomain(s.siteKey) === domain)?.siteKey || null;
    });
  }, [outerStops]);

  const handleLegendClick = useCallback((siteKey) => {
    setActiveSiteKey(siteKey);
    if (onLegendClick) onLegendClick(siteKey);
  }, [onLegendClick]);

  // Legend grouped by domain (follows domain order for visual consistency)
  const legendGroups = useMemo(() => {
    const byDomain = new Map(domainOrder.map((d) => [d, []]));
    outerStops.forEach((stop) => {
      const rd = registrableDomain(stop.siteKey);
      if (byDomain.has(rd)) byDomain.get(rd).push(stop);
    });
    return domainOrder.map((domain) => ({
      domain,
      domainColor: colorMap[domain] || "#8c8c8c",
      items: byDomain.get(domain) || [],
    }));
  }, [outerStops, domainOrder, colorMap]);

  return (
    <Flex gap={24} wrap="wrap" align="stretch">
      <Flex justify="center" align="center" style={{ flex: "0 0 220px", width: 220 }}>
        <svg
          role="img"
          aria-label="Storage distribution pie chart"
          width={CHART_SIZE}
          height={CHART_SIZE}
          viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
          style={{ flexShrink: 0 }}
        >
          {/* Outer ring: individual siteKeys */}
          {outerStops.map((item) => {
            const isActive = activeSiteKey === item.siteKey;
            const isDimmed = activeDomain !== null && registrableDomain(item.siteKey) !== activeDomain;
            return (
              <g
                key={item.siteKey}
                style={{
                  transition: "transform 0.3s ease, opacity 0.2s ease",
                  transformOrigin: `${CHART_CENTER}px ${CHART_CENTER}px`,
                  transform: isActive ? `translate(${item.offset.dx}px, ${item.offset.dy}px)` : "translate(0, 0)",
                  opacity: isDimmed ? 0.3 : 1,
                  cursor: "pointer",
                }}
                onClick={() => handleOuterClick(item.siteKey)}
              >
                <path
                  d={item.path}
                  fill={item.color}
                  stroke="#fff"
                  strokeWidth={1}
                  fillRule="evenodd"
                  aria-label={`${item.siteKey}: ${fileSizeIEC(item.byteSize || 0)}`}
                />
              </g>
            );
          })}

          {/* Inner ring: eTLD+1 domains (only when multiple domains present) */}
          {showInnerRing && innerStops.map((item) => {
            const isActive = activeDomain === item.domain;
            return (
              <g
                key={item.domain}
                style={{
                  transition: "transform 0.3s ease",
                  transformOrigin: `${CHART_CENTER}px ${CHART_CENTER}px`,
                  transform: isActive ? `translate(${item.offset.dx}px, ${item.offset.dy}px)` : "translate(0, 0)",
                  cursor: "pointer",
                }}
                onClick={() => handleInnerClick(item.domain)}
              >
                <path
                  d={item.path}
                  fill={item.color}
                  stroke="#fff"
                  strokeWidth={1.5}
                  fillRule="evenodd"
                  aria-label={`${item.domain}: ${fileSizeIEC(item.byteSize || 0)}`}
                />
              </g>
            );
          })}

          {/* Center white hole with summary text */}
          <circle cx={CHART_CENTER} cy={CHART_CENTER} r={CENTER_R - 1} fill="#fff" />
          <text x={CHART_CENTER} y={CHART_CENTER - 6} textAnchor="middle" fill="#8c8c8c" fontSize={11}>
            {i18nMessage("dashboardDistributionTitle")}
          </text>
          <text x={CHART_CENTER} y={CHART_CENTER + 12} textAnchor="middle" fill="#1f1f1f" fontSize={13} fontWeight={600}>
            {fileSizeIEC(totalBytes)}
          </text>
        </svg>
      </Flex>

      <Flex
        data-testid="dashboard-distribution-legend"
        vertical
        gap={showInnerRing ? 12 : 10}
        style={{
          flex: "1 1 280px",
          minWidth: 280,
          height: 220,
          maxHeight: 220,
          overflowY: "auto",
          paddingRight: 4,
        }}
      >
        {legendGroups.map(({ domain, domainColor, items: groupItems }) => (
          <div key={domain}>
            {showInnerRing && (
              <Flex align="center" gap={6} style={{ marginBottom: 4 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 10, height: 10, borderRadius: 2, background: domainColor, flexShrink: 0 }}
                />
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>{domain}</Text>
              </Flex>
            )}
            {groupItems.map((item) => (
              <Flex
                key={item.siteKey}
                ref={(el) => { legendRefs.current[item.siteKey] = el; }}
                align="center"
                gap={10}
                onClick={() => handleLegendClick(item.siteKey)}
                style={{
                  minWidth: 0,
                  padding: showInnerRing ? "4px 8px 4px 24px" : "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: activeSiteKey === item.siteKey ? item.color + "18" : "transparent",
                  borderLeft: activeSiteKey === item.siteKey ? `3px solid ${item.color}` : "3px solid transparent",
                  transition: "background 0.25s ease, border-color 0.25s ease",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, flexShrink: 0 }}
                />
                <Flex justify="space-between" align="center" style={{ minWidth: 0, flex: 1, gap: 12 }}>
                  <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
                    <Text strong ellipsis={{ tooltip: item.siteKey }}>{item.siteKey}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {[i18nMessage("dashboardDistributionVersions", [String(item.versionCount)]), i18nMessage("dashboardDistributionMaps", [String(item.mapCount)]), fileSizeIEC(item.byteSize || 0)].join(" · ")}
                    </Text>
                  </Flex>
                  <Text type="secondary" style={{ flexShrink: 0 }}>
                    {`${item.percent.toFixed(1)}%`}
                  </Text>
                </Flex>
              </Flex>
            ))}
          </div>
        ))}
      </Flex>
    </Flex>
  );
}
