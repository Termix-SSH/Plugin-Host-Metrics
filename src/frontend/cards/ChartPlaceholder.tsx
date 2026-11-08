import { Skeleton } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

/** Stands in for a chart until it has enough readings to draw. */
export function ChartPlaceholder({ height }: { height: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="relative flex items-center justify-center text-[11px] text-muted-foreground"
      style={{ height }}
    >
      <Skeleton className="absolute inset-0 opacity-40" />
      <span className="relative">{t("hostMetrics.collecting")}</span>
    </div>
  );
}
