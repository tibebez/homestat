import { expect, test } from "bun:test";
import {
  getAllServices,
  getDistinctGroupNames,
  getServiceGroupLabel,
  getServicesByGroup,
  getServicesForView,
  getUngroupedServices,
  type Service,
  type ServiceListView,
} from "../src/index.ts";

const sampleServices: Service[] = [
  { type: "manual", name: "A", url: "http://localhost:3000", group: "Media" },
  { type: "manual", name: "B", url: "http://localhost:3001", group: null },
  { type: "manual", name: "C", url: "http://localhost:3002", group: "Monitoring" },
  { type: "manual", name: "D", url: "http://localhost:3003", group: "Media" },
  { type: "manual", name: "E", url: "http://localhost:3004" },
  { type: "manual", name: "F", url: "http://localhost:3005", group: "" },
];

test("returns all services without filtering", () => {
  const all = getAllServices(sampleServices);

  expect(all.length).toBe(sampleServices.length);
  expect(all).toEqual(sampleServices);
  expect(all).not.toBe(sampleServices);
});

test("returns distinct group names in stable first-seen order", () => {
  expect(getDistinctGroupNames(sampleServices)).toEqual(["Media", "Monitoring"]);
});

test("returns services in selected group only", () => {
  const media = getServicesByGroup(sampleServices, "Media");
  expect(media.map((service) => service.name)).toEqual(["A", "D"]);
});

test("normalizes whitespace when collecting distinct group names", () => {
  const services: Service[] = [
    { type: "manual", name: "A", url: "http://localhost:1", group: "Media" },
    { type: "manual", name: "B", url: "http://localhost:2", group: " Media " },
    { type: "manual", name: "C", url: "http://localhost:3", group: "Monitoring" },
  ];

  expect(getDistinctGroupNames(services)).toEqual(["Media", "Monitoring"]);
});

test("normalizes whitespace when filtering services by group", () => {
  const services: Service[] = [
    { type: "manual", name: "A", url: "http://localhost:1", group: "Media" },
    { type: "manual", name: "B", url: "http://localhost:2", group: " Media " },
    { type: "manual", name: "C", url: "http://localhost:3", group: "Monitoring" },
  ];

  const media = getServicesByGroup(services, "Media ");
  expect(media.map((service) => service.name)).toEqual(["A", "B"]);
});

test("returns ungrouped services (undefined, null, blank)", () => {
  const ungrouped = getUngroupedServices(sampleServices);
  expect(ungrouped.map((service) => service.name)).toEqual(["B", "E", "F"]);
});

test("returns group label for grouped services", () => {
  expect(getServiceGroupLabel(sampleServices[0])).toBe("Media");
});

test("returns placeholder for ungrouped services", () => {
  expect(getServiceGroupLabel(sampleServices[1])).toBe("Ungrouped");
  expect(getServiceGroupLabel(sampleServices[4], "No Group")).toBe("No Group");
});

test("getServicesForView returns All Services in original order", () => {
  const services: Service[] = [
    { type: "manual", name: "A", url: "http://localhost:1" },
    { type: "manual", name: "B", url: "http://localhost:2" },
    { type: "manual", name: "C", url: "http://localhost:3" },
  ];

  const view: ServiceListView = { kind: "all" };
  const ordered = getServicesForView(services, view);
  expect(ordered.map((service) => service.name)).toEqual(["A", "B", "C"]);
});

test("getServicesForView filters Group view while preserving original order", () => {
  const services: Service[] = [
    { type: "manual", name: "A", url: "http://localhost:1", group: "Media" },
    { type: "manual", name: "B", url: "http://localhost:2", group: "Media" },
    { type: "manual", name: "C", url: "http://localhost:3", group: "Other" },
    { type: "manual", name: "D", url: "http://localhost:4", group: "Media" },
  ];

  const view: ServiceListView = { kind: "group", groupName: "Media" };
  const ordered = getServicesForView(services, view);
  expect(ordered.map((service) => service.name)).toEqual(["A", "B", "D"]);
});
