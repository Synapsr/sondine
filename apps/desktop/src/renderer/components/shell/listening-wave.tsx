import { cn } from "@sondine/ui";

// The top bar's listening mark (ADR 037): a small wave. While listening and
// nobody speaks, it rests flat and grey (idle); while the VAD hears speech its
// bars turn a light red and move, so it follows the signal and never loops
// for decoration. « Réduire les animations » keeps it still. A partial
// capture is amber. Paused, the control shows a play icon instead.

const BARS = [0.55, 0.85, 1, 0.7, 0.5];

export function ListeningWave({ speaking, tone }: { speaking: boolean; tone: "live" | "partial" }) {
  return (
    <span aria-hidden className="flex h-[1rem] items-center gap-[2px]">
      {BARS.map((height, index) => (
        <span
          key={index}
          className={cn(
            "w-[3px] origin-center corner-full",
            tone === "partial" ? "bg-warning" : speaking ? "bg-error opacity-70" : "bg-neutral-6",
            speaking
              ? "motion-safe:animate-[sondine-wave_900ms_ease-in-out_infinite]"
              : "scale-y-[0.5]",
          )}
          style={{
            height: `${height * 100}%`,
            animationDelay: `${index * 120}ms`,
          }}
        />
      ))}
    </span>
  );
}
