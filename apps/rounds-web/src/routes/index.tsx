import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

export const Route = createFileRoute("/")({ component: Ward });

interface Observation {
  readonly id: string;
  readonly patientId: string;
  readonly code: string;
  readonly value: string;
  readonly takenAt: number;
  readonly author: string;
  readonly amends: string | null;
}

interface Patient {
  readonly id: string;
  readonly name: string;
  readonly bed: string;
}

/**
 * The ward, as the station sees it.
 *
 * Reads are one round trip and there is no subscription: a live query is a fold on the device
 * that holds the log, and this browser holds nothing. What it gets instead is that the phones on
 * the ward are on the same relay, so a reading taken with no signal appears on the next read
 * after it syncs — without this page polling anything but its own refresh.
 */
function Ward() {
  const [patients, setPatients] = useState<readonly Patient[]>([]);
  const [selected, setSelected] = useState<string>();
  const [readings, setReadings] = useState<readonly Observation[]>([]);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    try {
      const list = await api.patients.list();
      setPatients(list);
      if (selected === undefined) setSelected(list[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => void refresh(), []);
  useEffect(() => {
    if (selected === undefined) return;
    void (async () => {
      const rows = await api.observations.forPatient({ patientId: selected });
      setReadings(rows);
    })();
  }, [selected]);

  const admit = async () => {
    const id = crypto.randomUUID();
    await api.patients.admit({
      id,
      name: `Patient ${id.slice(0, 4)}`,
      bed: `${patients.length + 1}A`,
    });
    await refresh();
  };

  const record = async () => {
    if (selected === undefined) return;
    await api.observations.record({
      patientId: selected,
      code: "BP",
      value: `${110 + Math.floor(Math.random() * 30)}/${70 + Math.floor(Math.random() * 20)}`,
      takenAt: Date.now(),
      author: "station",
    });
    setSelected(selected); // re-reads through the effect
    const rows = await api.observations.forPatient({ patientId: selected });
    setReadings(rows);
  };

  if (error !== undefined)
    return (
      <main>
        <h1>Rounds</h1>
        <p role="alert">{error}</p>
      </main>
    );

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", display: "grid", gap: "1.5rem" }}>
      <header>
        <h1 style={{ margin: 0 }}>Rounds</h1>
        <p style={{ margin: 0, opacity: 0.7 }}>
          The ward station. The phones on this ward are on the same relay.
        </p>
      </header>

      <section>
        <h2>Patients</h2>
        <ul
          style={{
            display: "flex",
            gap: "0.5rem",
            listStyle: "none",
            padding: 0,
            flexWrap: "wrap",
          }}
        >
          {patients.map((patient) => (
            <li key={patient.id}>
              <button
                type="button"
                onClick={() => setSelected(patient.id)}
                aria-pressed={patient.id === selected}
                style={{ padding: "0.5rem 0.75rem" }}
              >
                {patient.bed} · {patient.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void admit()}>
          Admit a patient
        </button>
      </section>

      <section>
        <h2>Readings</h2>
        {readings.length === 0 ? (
          <p>Nothing recorded for this patient yet.</p>
        ) : (
          <ol>
            {readings.map((o) => (
              <li key={o.id}>
                <strong>{o.code}</strong> {o.value} — {o.author}
                {o.amends === null ? null : <em> (amends an earlier reading)</em>}
              </li>
            ))}
          </ol>
        )}
        <button type="button" onClick={() => void record()} disabled={selected === undefined}>
          Record a blood pressure
        </button>
      </section>
    </main>
  );
}
