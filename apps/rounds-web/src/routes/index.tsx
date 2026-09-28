import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

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

const said = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const at = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The ward, as the station sees it.
 *
 * Every call is one round trip to the mesh on the server, and every one of them can fail — so
 * each action reports what went wrong rather than leaving a button that looks like it did
 * nothing. There is no subscription: a live query is a fold on the device holding the log, and
 * this browser holds none of it.
 */
function Ward() {
  const [patients, setPatients] = useState<readonly Patient[]>([]);
  const [selected, setSelected] = useState<string>();
  const [readings, setReadings] = useState<readonly Observation[]>([]);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();

  /** Runs one action, and makes its failure visible instead of an unhandled rejection. */
  const act = useCallback(async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    setProblem(undefined);
    try {
      await run();
    } catch (cause) {
      setProblem(`${what} failed: ${said(cause)}`);
    } finally {
      setBusy(undefined);
    }
  }, []);

  const loadPatients = useCallback(async () => {
    const list = await api.patients.list();
    setPatients(list);
    setSelected((held) => held ?? list[0]?.id);
  }, []);

  const loadReadings = useCallback(async (patientId: string) => {
    setReadings(await api.observations.forPatient({ patientId }));
  }, []);

  useEffect(() => {
    void act("loading the ward", loadPatients);
  }, [act, loadPatients]);

  useEffect(() => {
    if (selected === undefined) return;
    void act("loading readings", () => loadReadings(selected));
  }, [act, loadReadings, selected]);

  const admit = () =>
    act("admitting", async () => {
      const id = crypto.randomUUID();
      await api.patients.admit({
        id,
        name: `Patient ${id.slice(0, 4)}`,
        bed: `${String(patients.length + 1)}A`,
      });
      await loadPatients();
    });

  const record = () =>
    act("recording", async () => {
      if (selected === undefined) return;
      await api.observations.record({
        patientId: selected,
        code: "BP",
        value: `${String(110 + Math.floor(Math.random() * 30))}/${String(70 + Math.floor(Math.random() * 20))}`,
        takenAt: Date.now(),
        author: "station",
      });
      await loadReadings(selected);
    });

  return (
    <main className="page">
      <header>
        <h1>Rounds</h1>
        <p>The ward station. The phones on this ward are on the same relay.</p>
      </header>

      {problem === undefined ? null : (
        <div className="problem" role="alert">
          <strong>{problem}</strong>
          <p>
            Every read and write here is a call to the mesh on the server; this one did not land.
          </p>
        </div>
      )}

      <section>
        <h2>Patients</h2>
        {patients.length === 0 ? (
          <p className="empty">Nobody admitted yet.</p>
        ) : (
          <ul className="beds">
            {patients.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  className="bed"
                  aria-pressed={patient.id === selected}
                  onClick={() => setSelected(patient.id)}
                >
                  <strong>Bed {patient.bed}</strong>
                  <span>{patient.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="act"
          onClick={() => void admit()}
          disabled={busy !== undefined}
        >
          {busy === "admitting" ? "Admitting…" : "Admit a patient"}
        </button>
      </section>

      <section>
        <h2>Readings</h2>
        {readings.length === 0 ? (
          <p className="empty">
            {selected === undefined
              ? "Admit someone first."
              : "Nothing recorded for this patient yet."}
          </p>
        ) : (
          <ul className="readings">
            {readings.map((o) => (
              <li key={o.id} className="reading">
                <span className="code">{o.code}</span>
                <span className="value">{o.value}</span>
                {o.amends === null ? null : (
                  <span className="amends">amends an earlier reading</span>
                )}
                <span className="by">
                  {o.author} · {at(o.takenAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="act"
          onClick={() => void record()}
          disabled={selected === undefined || busy !== undefined}
        >
          {busy === "recording" ? "Recording…" : "Record a blood pressure"}
        </button>
      </section>
    </main>
  );
}
