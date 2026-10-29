import { createContext, useContext, useState } from "react";
import {
  Button,
  Checkbox,
  Field,
  FormFooter,
  InlineView,
  Input,
  Select2,
} from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Settings2 } from "lucide-react";
import {
  CARD_SETTINGS,
  GRID_COLUMNS,
  MIN_CARD_COLUMNS,
  sanitizeCardSettings,
  type HostMetricsCardId,
  type HostMetricsCardSettings,
  type HostMetricsLayout,
} from "../shared/host-metrics.js";

export const CardSettingsContext = createContext<HostMetricsCardSettings>({});
export const useCardSettings = () => useContext(CardSettingsContext);
export function chartHeight(
  settings: HostMetricsCardSettings,
  regular: number,
) {
  return Math.round(
    regular *
      (settings.chartSize === "compact"
        ? 0.65
        : settings.chartSize === "large"
          ? 1.5
          : 1),
  );
}

export function CardSettingsView({
  id,
  label,
  slot,
  renderedHeight = 160,
  onSave,
  onClose,
}: {
  id: HostMetricsCardId;
  label: string;
  slot: HostMetricsLayout["slots"][number];
  renderedHeight?: number;
  onSave: (patch: Partial<HostMetricsLayout["slots"][number]>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(slot.settings ?? {});
  const [width, setWidth] = useState<number | "">(slot.w ?? MIN_CARD_COLUMNS);
  const [height, setHeight] = useState<number | "">(slot.height ?? "");
  const current = width === "" ? MIN_CARD_COLUMNS : width;
  const valid =
    Number.isInteger(width) &&
    current >= MIN_CARD_COLUMNS &&
    current <= GRID_COLUMNS &&
    (height === "" ||
      (Number.isFinite(height) && height >= 80 && height <= 10000));
  const text = (key: string) => t(`hostMetrics.cardSettings.${key}`);
  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("hostMetrics.cardSettings.title", { card: label })}
      icon={<Settings2 className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => {
            onSave({
              settings: sanitizeCardSettings(id, draft),
              w: current,
              height: height === "" ? null : Math.round(height),
            });
            onClose();
          }}
          disabled={!valid}
          saveLabel={t("common.save")}
          cancelLabel={t("common.cancel")}
        />
      }
    >
      <div className="flex max-w-md flex-col gap-4">
        <p className="text-xs text-muted-foreground">{text("sizeHint")}</p>
        <Field label={text("widthColumns")}>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={text("narrower")}
              onClick={() => setWidth(Math.max(MIN_CARD_COLUMNS, current - 1))}
            >
              -
            </Button>
            <Input
              type="number"
              aria-label={text("widthColumns")}
              min={MIN_CARD_COLUMNS}
              max={GRID_COLUMNS}
              step={1}
              value={width}
              onChange={(event) =>
                setWidth(
                  event.target.value === "" ? "" : event.target.valueAsNumber,
                )
              }
            />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={text("wider")}
              onClick={() => setWidth(Math.min(GRID_COLUMNS, current + 1))}
            >
              +
            </Button>
          </div>
        </Field>
        <Field label={text("height")}>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={text("shorter")}
              onClick={() =>
                setHeight(
                  Math.max(80, (height === "" ? renderedHeight : height) - 10),
                )
              }
            >
              -
            </Button>
            <Input
              type="number"
              aria-label={text("height")}
              min={80}
              max={10000}
              step={1}
              value={height}
              placeholder={text("auto")}
              onChange={(event) =>
                setHeight(
                  event.target.value === "" ? "" : event.target.valueAsNumber,
                )
              }
            />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={text("taller")}
              onClick={() =>
                setHeight(
                  Math.min(
                    10000,
                    (height === "" ? renderedHeight : height) + 10,
                  ),
                )
              }
            >
              +
            </Button>
          </div>
        </Field>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setHeight("")}
        >
          {text("autoSize")}
        </Button>
        {(CARD_SETTINGS[id] ?? []).map((key) =>
          key === "chartSize" ? (
            <Field key={key} label={text(key)}>
              <Select2
                aria-label={text(key)}
                value={draft.chartSize ?? "regular"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    chartSize: event.target
                      .value as HostMetricsCardSettings["chartSize"],
                  })
                }
              >
                {["compact", "regular", "large"].map((value) => (
                  <option key={value} value={value}>
                    {text(value)}
                  </option>
                ))}
              </Select2>
            </Field>
          ) : (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Checkbox
                className="border-border bg-background data-[state=checked]:border-accent-brand data-[state=checked]:bg-accent-brand/20 data-[state=checked]:text-foreground dark:bg-background dark:data-[state=checked]:bg-accent-brand/20"
                checked={
                  key === "showCoreGraphs"
                    ? draft[key] === true
                    : draft[key] !== false
                }
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, [key]: checked === true })
                }
              />
              {text(key)}
            </label>
          ),
        )}
        {!!CARD_SETTINGS[id]?.length && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setDraft({})}
          >
            {text("defaults")}
          </Button>
        )}
      </div>
    </InlineView>
  );
}
