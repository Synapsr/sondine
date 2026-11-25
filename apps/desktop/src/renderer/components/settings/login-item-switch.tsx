import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useEffect, useState } from "react";
import { m } from "../../paraglide/messages.js";

/**
 * « Ouvrir Sondine à l'ouverture de session »: a macOS login item, so
 * listening starts with the session. macOS keeps the setting; main reads and
 * writes it.
 */
export function LoginItemSwitch() {
  const [open, setOpen] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    window.sondine
      .loginItem()
      .then((value) => {
        if (live) setOpen(value);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={open ?? false}
          disabled={open === null}
          onCheckedChange={(checked) => {
            setOpen(checked);
            // macOS has the last word: the switch shows what it reports.
            window.sondine
              .loginItem(checked)
              .then((value) => {
                setOpen(value);
                setFailed(value !== checked);
              })
              .catch(() => {
                setFailed(true);
                void window.sondine.loginItem().then(setOpen, () => setOpen(null));
              });
          }}
        />
        {m.settings_login_item()}
      </SwitchLabel>
      <p className="text-body-s text-cte-text-muted">{m.settings_login_item_hint()}</p>
      {failed ? (
        <p role="alert" className="text-body-s text-error">
          {m.error_generic()}
        </p>
      ) : null}
    </div>
  );
}
