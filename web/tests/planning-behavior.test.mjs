import assert from "node:assert/strict";
import test from "node:test";

const planning = await import("../app/planning.mjs").catch(() => ({}));

const INPUTS = {
  "01_LINES.csv": "line_code,line_name\nALP,Line Alpha\n",
  "02_STATIONS.csv": "station_id,line_code,seq,is_interchange\nS01,ALP,1,0\nS02,ALP,2,0\n",
  "03_SECTORS.csv": "sector_id,line_code,from_station_id,to_station_id,seq,is_shared\nSEC:ALP:S01_S02,ALP,S01,S02,1,0\n",
  "06_PARAMETERS.csv": "key,value\nhorizon_start,2027-01-04\nhorizon_weeks,30\n",
  "07_PROJECT_DETAILS.csv": "contract_number,contract_description,activity_type,nature_of_activity,contract_priority\nC001,Renewal programme,Renewal,Non-live,2\n",
  "08_ACTIVITY_DETAILS.csv": "activity_id,contract_number,activity_type,start_location_id,end_location_id,total_accesses,planned_start_date,predecessor_activity_id,activity_priority\nA001,C001,Renewal,SEC:ALP:S01_S02:EB,SEC:ALP:S01_S02:EB,2,2027-01-11,,1\n",
};

const OUTPUTS = {
  "SCHEDULE_ACCESS.csv": "activity_id,access_seq,week,eclo,access_night\nA001,1,2,0,1\nA001,2,3,1,2\n",
  "SCHEDULE_OCCUPANCY.csv": "activity_id,week,location_id,co_share_group\nA001,2,SEC:ALP:S01_S02:EB,g1\nA001,3,PLAT:ALP:S02:EB,g2\n",
};

test("planning parser handles quoted CSV fields", () => {
  assert.equal(typeof planning.parseCsv, "function");
  assert.deepEqual(planning.parseCsv('id,label\n1,"Alpha, East"\n'), [
    { id: "1", label: "Alpha, East" },
  ]);
});

test("best-policy selection uses the lowest feasible official objective score", () => {
  assert.equal(typeof planning.selectBestPolicy, "function");
  const selected = planning.selectBestPolicy({
    A: { report: { feasible: true, soft_scores: { objective_score: 41.3 } } },
    B: { report: { feasible: false, soft_scores: { objective_score: 1 } } },
    C: { report: { feasible: true, soft_scores: { objective_score: 32.2 } } },
  });
  assert.equal(selected, "C");
});

test("planning model links access weeks and occupied railway locations", () => {
  assert.equal(typeof planning.buildPlanningModel, "function");
  const model = planning.buildPlanningModel(INPUTS, OUTPUTS);

  assert.equal(model.horizonStart, "2027-01-04");
  assert.equal(model.horizonWeeks, 30);
  assert.equal(model.lines[0].stations.length, 2);
  assert.equal(model.activities[0].startWeek, 2);
  assert.equal(model.activities[0].endWeek, 3);
  assert.equal(model.activities[0].accesses[1].eclo, true);
  assert.deepEqual(model.activities[0].occupiedLocations, [
    "SEC:ALP:S01_S02:EB",
    "PLAT:ALP:S02:EB",
  ]);
});

test("week labels are derived from the supplied horizon start", () => {
  assert.equal(typeof planning.formatWeekStart, "function");
  assert.equal(planning.formatWeekStart("2027-01-04", 2), "11 Jan 2027");
});

test("workday suggestions order by contract priority, then job type, deterministically", () => {
  assert.equal(typeof planning.recommendWorkdays, "function");
  const picks = planning.recommendWorkdays([
    { key: "A9|5", activityId: "A9", contractPriority: 3, nature: "Non-live (Others)", accessType: "C", seq: 1 },
    { key: "A1|5", activityId: "A1", contractPriority: 1, nature: "Non-live (Consist)", accessType: "C", seq: 1 },
    { key: "A2|5", activityId: "A2", contractPriority: 1, nature: "Live", accessType: "PM", seq: 2 },
    { key: "A3|5", activityId: "A3", contractPriority: 1, nature: "Live", accessType: "PM", seq: 1 },
  ]);
  assert.deepEqual(picks.map((pick) => pick.key), ["A3|5", "A2|5", "A1|5", "A9|5"]);
  assert.deepEqual(picks.map((pick) => pick.day), [0, 0, 0, 0]);
  assert.ok(picks.every((pick) => typeof pick.reason === "string" && pick.reason.length > 0));
});

test("workday suggestions keep shared possessions together and clashers apart", () => {
  const loc = "SEC:ALP:S02_S03:EB";
  const picks = planning.recommendWorkdays([
    { key: "A|5", activityId: "A", contractPriority: 1, nature: "Non-live (Consist)", accessType: "PC", seq: 1, locations: [loc], groups: { [loc]: "b1" } },
    { key: "B|5", activityId: "B", contractPriority: 2, nature: "Non-live (Consist)", accessType: "C", seq: 1, locations: [loc], groups: { [loc]: "b1" } },
    { key: "C|5", activityId: "C", contractPriority: 2, nature: "Non-live (Consist)", accessType: "C", seq: 1, locations: [loc], groups: { [loc]: "b2" } },
  ]);
  const dayOf = Object.fromEntries(picks.map((pick) => [pick.key, pick.day]));
  assert.equal(dayOf["A|5"], dayOf["B|5"]);
  assert.notEqual(dayOf["C|5"], dayOf["A|5"]);
  assert.match(picks.find((pick) => pick.key === "B|5").reason, /Shares b1 possession/);
});

test("workday suggestions separate Live works on a line and respect workfronts", () => {
  const live = (key, id, contract, extra = {}) => ({
    key, activityId: id, contractNumber: contract, contractPriority: 1,
    nature: "Live", accessType: "PM", seq: 1,
    locations: ["SEC:ALP:S02_S03:EB"], groups: {}, workfronts: 1, ...extra,
  });
  const picks = planning.recommendWorkdays([
    live("A|5", "A", "C1"),
    live("B|5", "B", "C1", { locations: ["SEC:ALP:S02_S03:EB"] }),
  ]);
  const dayOf = Object.fromEntries(picks.map((pick) => [pick.key, pick.day]));
  assert.notEqual(dayOf["A|5"], dayOf["B|5"]);
  const capped = planning.recommendWorkdays([
    { key: "A|5", activityId: "A", contractNumber: "C1", contractPriority: 2, nature: "Non-live (Others)", accessType: "C", seq: 1, locations: ["SEC:ALP:S01_S02:EB"], groups: {}, workfronts: 1 },
    { key: "B|5", activityId: "B", contractNumber: "C1", contractPriority: 2, nature: "Non-live (Others)", accessType: "C", seq: 2, locations: ["SEC:BET:S11_S12:EB"], groups: {}, workfronts: 1 },
  ]);
  assert.notEqual(capped[0].day, capped[1].day);
});
