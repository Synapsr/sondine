import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { useEffect } from "react";
import { Button } from "../../components/button";
import {
  createToastManager,
  Toast,
  ToastAction,
  ToastActions,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "../../components/toast";
import { Section, Specimen } from "../section";

const CLOSE_LABEL = "Fermer";

function Triggers() {
  const toasts = useToastManager();
  return (
    <>
      <Button
        variant="outline"
        onClick={() =>
          toasts.add({
            title: "Conversation enregistrée",
            description: "Point hebdo produit · Zoom · 42 min",
          })
        }
      >
        Terminer l’enregistrement
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const id = toasts.add({
            title: "Conversation supprimée",
            description: "Point hebdo produit",
            actionProps: { children: "Annuler", onClick: () => toasts.close(id) },
          });
        }}
      >
        Supprimer la conversation
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toasts.add({
            title: "Écoute en pause",
            description: "Reprise automatique dans 15 minutes.",
            actionProps: { children: "Reprendre" },
          })
        }
      >
        Mettre en pause l’écoute
      </Button>
      <Button variant="outline" disabled>
        Exporter
      </Button>
    </>
  );
}

// The static stack lives in its own provider so its toasts never time out
// and stay inside the section.
const examples = createToastManager();
const DISABLED_ID = "example-disabled";

function ExampleList() {
  const { toasts } = useToastManager();
  return toasts.map((toast) =>
    toast.id === DISABLED_ID ? (
      <ToastRoot key={toast.id} toast={toast}>
        <ToastContent>
          <ToastTitle data-disabled="" />
          <ToastDescription data-disabled="" />
          <ToastActions>
            <ToastAction disabled>Annuler</ToastAction>
          </ToastActions>
          <ToastClose aria-label={CLOSE_LABEL} disabled />
        </ToastContent>
      </ToastRoot>
    ) : (
      <Toast key={toast.id} toast={toast} closeLabel={CLOSE_LABEL} />
    ),
  );
}

export default function ToastSection() {
  // The provider subscribes to the manager in its own effect, which runs first.
  useEffect(() => {
    examples.add({
      id: "example-rest",
      title: "Conversation enregistrée",
      description: "Point hebdo produit · Zoom · 42 min",
      timeout: 0,
    });
    examples.add({
      id: "example-action",
      title: "Conversation supprimée",
      description: "Entretien avec Camille · 18 min",
      actionProps: { children: "Annuler" },
      timeout: 0,
    });
    examples.add({
      id: DISABLED_ID,
      title: "Conversation supprimée",
      description: "La corbeille a été vidée : annulation impossible.",
      timeout: 0,
    });
  }, []);

  return (
    <Section id="toast" title="Toast">
      <Specimen label="Live (bottom right)">
        <ToastProvider closeLabel={CLOSE_LABEL} regionLabel="Notifications">
          <Triggers />
        </ToastProvider>
      </Specimen>
      <Specimen label="Rest, with action, disabled">
        <ToastPrimitive.Provider toastManager={examples}>
          <ToastViewport
            aria-label="Exemples de notifications"
            className="relative inset-auto z-0 h-[26rem]"
          >
            <ExampleList />
          </ToastViewport>
        </ToastPrimitive.Provider>
      </Specimen>
    </Section>
  );
}
