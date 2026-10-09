import { fail, known, onServer, prepare, type Host } from "./server-run";
import {
  CONTAINERS_UNIX, SERVICES_UNIX, SERVICES_WINDOWS, containerActionUnix, containerLogUnix, containerName, containerPlanUnix, followCommand, formatContainerAction,
  formatContainerLog, formatContainers, formatLog, formatServiceAction, formatServiceActionWindows, formatServices, formatServicesWindows, serviceActionUnix,
  serviceActionWindows, serviceLogUnix, servicePlanUnix, servicePlanWindows, unitName, windowsServiceName, type CtrVerb, type Verb,
} from "./server-services-core";
import { psq, shq } from "./server-tools-core";
import type { Tool } from "./toolbox";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const noWindows = (what: string) => fail(`${what} isn't supported on Windows servers yet`);

/** Start, stop, restart or reload one service. The dialog names the exact command and waits for a press of the button. */
function serviceTool(host: Host, verb: Verb): Tool {
  const name = cap(verb);
  const hints: Record<Verb, string> = { start: "start a stopped service", stop: "stop a running service", restart: "stop and start a service again", reload: "make a service re-read its settings" };
  return {
    id: `service-${verb}`, heading: `${name} a service: ${host.name}`, title: `${name} a service…`, hint: hints[verb], keywords: `server host systemctl daemon unit ${verb}`,
    input: { label: "Service name", hint: "like nginx or ssh. On Windows, the short name, like Spooler." },
    prepare: prepare(host),
    action: {
      label: name,
      plan: (text) => {
        if (known(host) !== "windows") return servicePlanUnix(verb, text);
        return verb === "reload" ? noWindows("Reloading a service") : servicePlanWindows(verb, text);
      },
      terminal: (text) =>
        host.type(known(host) === "windows" ? `powershell -NoProfile -Command "${name}-Service -Name ${psq(windowsServiceName(text))}"` : `sudo systemctl ${verb} ${shq(unitName(text))}`, false),
    },
    run: (text) =>
      onServer(host, 60, (os) => {
        if (os !== "windows") return { script: serviceActionUnix(verb, text), read: (t) => formatServiceAction(verb, text.trim(), t) };
        if (verb === "reload") return noWindows("Reloading a service");
        return { script: serviceActionWindows(verb, text), read: (t) => formatServiceActionWindows(verb, text.trim(), t) };
      }),
  };
}

function containerTool(host: Host, verb: CtrVerb): Tool {
  const name = cap(verb);
  const hints: Record<CtrVerb, string> = { start: "start a stopped container", stop: "stop a running container", restart: "stop and start a container again" };
  return {
    id: `container-${verb}`, heading: `${name} a container: ${host.name}`, title: `${name} a container…`, hint: hints[verb], keywords: `server host docker podman ${verb}`,
    input: { label: "Container name", hint: "a name or id from the container list" },
    prepare: prepare(host),
    action: {
      label: name,
      plan: (text) => (known(host) === "windows" ? noWindows("Containers") : containerPlanUnix(verb, text)),
      terminal: (text) => host.type(`docker ${verb} ${shq(containerName(text))}`, false),
    },
    run: (text) =>
      onServer(host, 90, (os) => (os === "windows" ? noWindows("Containers") : { script: containerActionUnix(verb, text), read: (t) => formatContainerAction(verb, text.trim(), t) })),
  };
}

/** Services, containers and logs. Listing and reading change nothing; the rest are actions that ask first. */
export function operateTools(host: Host): Tool[] {
  const heading = (t: string) => `${t}: ${host.name}`;
  return [
    {
      id: "services", heading: heading("Services"), title: "Services…", hint: "what is running, and what has failed", keywords: "server host systemctl systemd daemons units running failed windows",
      input: { label: "Filter", hint: "part of a name or description. Empty shows what is running." }, blank: true, auto: true, again: "Refresh",
      run: (text) =>
        onServer(host, 30, (os) =>
          os === "windows" ? { script: SERVICES_WINDOWS, read: (t) => formatServicesWindows(t, host.name, text) } : { script: SERVICES_UNIX, read: (t) => formatServices(t, host.name, text) }),
    },
    ...(["restart", "stop", "start", "reload"] as const).map((v) => serviceTool(host, v)),
    {
      id: "service-log", heading: heading("Service log"), title: "Service log…", hint: "the last 200 journal lines of a service", keywords: "server host journalctl journal logs systemd output errors",
      input: { label: "Service name", hint: "like nginx or ssh. Reads only what this account may read." },
      run: (text) => onServer(host, 30, (os) => (os === "windows" ? noWindows("The service log") : { script: serviceLogUnix(text), read: (t) => formatLog(t, text.trim()) })),
    },
    {
      id: "follow-log", heading: heading("Follow a log"), title: "Follow a log…", hint: "watch a file or a service's journal in the terminal", keywords: "server host tail -f journalctl follow live watch logs",
      input: { label: "Log file or service", hint: "a path like /var/log/syslog, or a service name like nginx" },
      action: {
        label: "Follow",
        plan: (text) => `Will type this into the terminal and press Enter:\n  ${followCommand(text)}\n\nIt keeps going until you press Ctrl+C.`,
        closes: true,
      },
      run: (text) => {
        host.type(followCommand(text), true);
        return "Started in the terminal.";
      },
    },
    {
      id: "containers", heading: heading("Containers"), title: "Containers…", hint: "docker or podman containers, running and stopped", keywords: "server host docker podman images running stopped",
      again: "Refresh",
      run: () => onServer(host, 45, (os) => (os === "windows" ? noWindows("Containers") : { script: CONTAINERS_UNIX, read: (t) => formatContainers(t, host.name) })),
    },
    ...(["restart", "stop", "start"] as const).map((v) => containerTool(host, v)),
    {
      id: "container-log", heading: heading("Container log"), title: "Container log…", hint: "the last 200 lines a container printed", keywords: "server host docker podman logs output errors",
      input: { label: "Container name", hint: "a name or id from the container list" },
      run: (text) => onServer(host, 45, (os) => (os === "windows" ? noWindows("Containers") : { script: containerLogUnix(text), read: (t) => formatContainerLog(t, text.trim()) })),
    },
  ];
}
