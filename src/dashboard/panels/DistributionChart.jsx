import { useState, useMemo, useRef, useCallback } from "react";
import { Flex, Typography } from "antd";
import { fileSizeIEC, i18nMessage } from "../../shared/utils.mjs";

const { Text } = Typography;

const distributionPalette = [
  "#1677ff",
  "#52c41a",
  "#faad14",
  "#722ed1",
  "#eb2f96",
  "#13c2c2",
  "#fa541c",
  "#2f54eb",
];

const CHART_SIZE = 220;
const CHART_PAD = 12;
const CHART_CENTER = CHART_SIZE / 2;
const CHART_RADIUS = CHART_CENTER - CHART_PAD;

function polarToCartesian(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function slicePath(cx, cy, r, startDeg, endDeg) {
  if (endDeg - startDeg >= 360) {
    // A 360° arc has identical start and end points, making a single arc command
    // degenerate (SVG ignores it). Split into two 180° arcs instead.
    const top = polarToCartesian(cx, cy, r, startDeg);
    const bottom = polarToCartesian(cx, cy, r, startDeg + 180);
    return [
      `M ${cx} ${cy}`,
      `L ${top.x} ${top.y}`,
      `A ${r} ${r} 0 1 1 ${bottom.x} ${bottom.y}`,
      `A ${r} ${r} 0 1 1 ${top.x} ${top.y}`,
      "Z",
    ].join(" ");
  }
  const start = polarToCartesian(cx, cy, r, startDeg);
  const end = polarToCartesian(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function sliceOffset(r, startDeg, endDeg) {
  if (endDeg - startDeg >= 360) {
    // Full circle has no meaningful outward direction; skip translation.
    return { dx: 0, dy: 0 };
  }
  const midDeg = (startDeg + endDeg) / 2;
  const rad = (midDeg - 90) * Math.PI / 180;
  const distance = r * 0.06;
  return {
    dx: Math.cos(rad) * distance,
    dy: Math.sin(rad) * distance,
  };
}

export default function DistributionChart({ items, onLegendClick }) {
  const [activeSiteKey, setActiveSiteKey] = useState(null);
  const legendRefs = useRef({});

  const normalizedItems = useMemo(() => {
    return items
     .filter((item) => item && item.siteKey)
     .slice()
     .sort((a, b) => (Number(b.byteSize) || 0) - (Number(a.byteSize) || 0))
     .map((item, index) => ({
       ...item,
       color: distributionPalette[index % distributionPalette.length],
     }));
  }, [items]);

  const totalBytes = useMemo(() => {
    return normalizedItems.reduce((sum, item) => sum + (Number(item.byteSize) || 0), 0);
  }, [normalizedItems]);

  const chartStops = useMemo(() => {
    if (!normalizedItems.length) return [];
    const totalWeight = totalBytes > 0 ? totalBytes : normalizedItems.length;
    let offset = 0;
    return normalizedItems.map((item) => {
     const weight = totalBytes > 0 ? (Number(item.byteSize) || 0) : 1;
     const nextOffset = offset + (weight / totalWeight) * 360;
     const stop = {
       ...item,
       from: offset,
       to: nextOffset,
       percent: totalBytes > 0 ? ((Number(item.byteSize) || 0) / totalBytes) * 100 : 0,
       offset: sliceOffset(CHART_RADIUS, offset, nextOffset),
       path: slicePath(CHART_CENTER, CHART_CENTER, CHART_RADIUS, offset, nextOffset),
     };
     offset = nextOffset;
     return stop;
    });
  }, [normalizedItems, totalBytes]);

  const handleSliceClick = useCallback((siteKey) => {
    setActiveSiteKey((prev) => prev === siteKey ? null : siteKey);
    const ref = legendRefs.current[siteKey];
    if (ref) {
      ref.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const handleLegendClick = useCallback((siteKey) => {
    setActiveSiteKey(siteKey);
    if (onLegendClick) onLegendClick(siteKey);
  }, [onLegendClick]);

  const chartCenter = CHART_CENTER;

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
         {chartStops.map((item) => (
           <g
             key={item.siteKey}
             style={{
               transition: "transform 0.3s ease",
               transformOrigin: `${chartCenter}px ${chartCenter}px`,
               transform: activeSiteKey === item.siteKey
                 ? `translate(${item.offset.dx}px, ${item.offset.dy}px)`
                 : "translate(0, 0)",
               cursor: "pointer",
             }}
             onClick={() => handleSliceClick(item.siteKey)}
           >
             <path
               d={item.path}
               fill={item.color}
               stroke="#fff"
               strokeWidth={1}
               style={{ transition: "opacity 0.2s ease" }}
               aria-label={`${item.siteKey}: ${fileSizeIEC(item.byteSize || 0)}`}
             />
           </g>
         ))}
         <circle
           cx={chartCenter}
           cy={chartCenter}
           r={CHART_RADIUS * 0.67}
           fill="#fff"
         />
         <text
           x={chartCenter}
           y={chartCenter - 6}
           textAnchor="middle"
           fill="#8c8c8c"
           fontSize={11}
         >
           {i18nMessage("dashboardDistributionTitle")}
         </text>
         <text
           x={chartCenter}
           y={chartCenter + 12}
           textAnchor="middle"
           fill="#1f1f1f"
           fontSize={13}
           fontWeight={600}
         >
           {fileSizeIEC(totalBytes)}
         </text>
       </svg>
     </Flex>
     <Flex
       data-testid="dashboard-distribution-legend"
       vertical
       gap={10}
       style={{
         flex: "1 1 280px",
         minWidth: 280,
         height: 220,
         maxHeight: 220,
         overflowY: "auto",
         paddingRight: 4,
       }}
     >
       {chartStops.map((item) => (
         <Flex
           key={item.siteKey}
           ref={(el) => { legendRefs.current[item.siteKey] = el; }}
           align="center"
           gap={10}
           onClick={() => handleLegendClick(item.siteKey)}
           style={{
             minWidth: 0,
             padding: "6px 8px",
             borderRadius: 6,
             cursor: "pointer",
             background: activeSiteKey === item.siteKey ? item.color + "18" : "transparent",
             borderLeft: activeSiteKey === item.siteKey ? `3px solid ${item.color}` : "3px solid transparent",
             transition: "background 0.25s ease, border-color 0.25s ease",
           }}
         >
           <span
             aria-hidden="true"
             style={{
               width: 10,
               height: 10,
               borderRadius: "50%",
               background: item.color,
               flexShrink: 0,
             }}
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
     </Flex>
    </Flex>
  );
}
