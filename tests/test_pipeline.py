"""Pipeline: zone → ricettari → compatibilità → proposte ARAG → documentazione, più l'import GeoJSON."""
import io
import json
import math
import unittest
import urllib.parse
import zipfile

from tests.helpers import BARE, FULL, VALVE_ONLY
from tests.test_http import ServerCase
from um import geoimport, isoxml, service
from um.hardware import load_catalog

DECL = {k: True for k in ("label_read", "mix_ok", "operator_license", "equipment_checked", "weather_buffer")}
OPERATOR = {"name": "Operatore di prova", "license_no": "X1", "target": "peronospora", "date_planned": "2026-10-12"}


def product(**kw):
    p = {"name": "Prodotto di prova", "reg_no": "00000", "source": "etichetta di prova", "dose_min": 1.5, "dose_max": 2.5,
         "unit": "L/ha", "vol_min": None, "vol_max": None, "price": 10}
    p.update(kw)
    return p


def session(example="zone_poligonali"):
    s = service.Session(sid="t")
    service.load_example(s, example)
    return s


def ndvi_geojson(boundary=False, crs=None, scale=1.0):
    d, feats = 0.0004, []
    for i in range(6):
        for j in range(5):
            lon, lat = (10.0 + i * d) * scale, 45.0 + j * d
            ring = [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]
            feats.append({"type": "Feature", "properties": {"NDVI": round(0.3 + 0.08 * i + 0.01 * j, 3)},
                          "geometry": {"type": "Polygon", "coordinates": [ring]}})
    if boundary:
        b = [[9.9999, 44.9999], [10.0025, 44.9999], [10.0025, 45.0021], [9.9999, 45.0021], [9.9999, 44.9999]]
        feats.append({"type": "Feature", "properties": {"role": "boundary"}, "geometry": {"type": "Polygon", "coordinates": [b]}})
    fc = {"type": "FeatureCollection", "features": feats}
    if crs:
        fc["crs"] = {"type": "name", "properties": {"name": crs}}
    return json.dumps(fc).encode()


class Zoning(unittest.TestCase):
    def test_four_zones_three_classes_with_area(self):
        z = service.zoning_payload(session(), {"task": 0})
        self.assertEqual([g["cls"] for g in z["groups"]], ["ridotta", "standard", "intensa"])
        self.assertAlmostEqual(sum(g["share_pct"] for g in z["groups"]), 100.0, delta=0.5)
        self.assertGreater(z["stats"]["cv_pct"], 0)
        self.assertTrue(z["provenance"]["acquired"] and z["provenance"]["computed"] and z["provenance"]["missing"])

    def test_zero_rate_is_excluded_and_continuous_map_uses_terciles(self):
        z = service.zoning_payload(session("griglia_tipo1"), {"task": 0})
        self.assertIn("esclusa", [g["cls"] for g in z["groups"]])
        z3 = service.zoning_payload(session("griglia_tipo2"), {"task": 0})
        shares = {g["cls"]: g["share_pct"] for g in z3["groups"]}
        for cls in ("ridotta", "standard", "intensa"):
            self.assertAlmostEqual(shares[cls], 33.3, delta=6.0)


class Recipes(unittest.TestCase):
    def build(self, example="zone_poligonali", products=None, **opt):
        s = session(example)
        return s, service.recipes_payload(s, {"task": 0, "products": [product()] if products is None else products,
                                              "options": opt, "config": FULL})

    def test_three_distinct_recipes_and_b_always_within_label(self):
        for ex in ("zone_poligonali", "griglia_tipo1", "griglia_tipo2"):
            _, r = self.build(ex)
            a, b, c = r["recipes"]
            self.assertEqual([x["id"] for x in r["recipes"]], ["aderente", "risparmio", "uniforme"])
            self.assertEqual(b["metrics"]["within_label_pct"], 100.0, ex)
            for z in b["zones"]:
                for dose in z["doses"]:
                    if dose is not None:
                        self.assertGreaterEqual(dose, 1.5 - 1e-6)
                        self.assertLessEqual(dose, 2.5 + 1e-6)
            self.assertFalse(c["variable"])
            self.assertEqual(c["metrics"]["within_label_pct"], 100.0)

    def test_a_is_flagged_when_one_tank_cannot_stay_in_label(self):
        _, r = self.build()          # volumi 150–340: rapporto 2,27 > 2,5/1,5
        a = r["recipes"][0]
        self.assertTrue(any(c["level"] == "fail" for c in a["constraints"]))
        self.assertLess(a["metrics"]["within_label_pct"], 100.0)
        self.assertFalse(a["complete"] and not a["constraints"])

    def test_totals_follow_volumes_and_areas(self):
        _, r = self.build(tank_l=2000)
        for rec in r["recipes"]:
            mix = sum(z["volume"] * z["area_ha"] for z in rec["zones"] if z["volume"])
            self.assertAlmostEqual(rec["totals"]["mixture_l"], mix, delta=0.5)
            self.assertEqual(rec["totals"]["tank_loads"], math.ceil(rec["totals"]["mixture_l"] / 2000))
            p = rec["products"][0]
            self.assertAlmostEqual(p["per_tank"], p["concentration"] * 2000, delta=0.02)
            self.assertAlmostEqual(rec["totals"]["cost"], p["quantity"] * 10, delta=0.05)

    def test_without_label_data_quantities_are_missing_not_invented(self):
        _, r = self.build(products=[])
        for rec in r["recipes"]:
            self.assertEqual(rec["products"], [])
            self.assertFalse(rec["complete"])
            self.assertTrue(any(c["level"] == "fail" for c in rec["constraints"]))
            self.assertIsNotNone(rec["totals"]["mixture_l"])
        _, r2 = self.build(products=[{"name": "Senza dati"}])
        self.assertIsNone(r2["recipes"][0]["products"][0]["quantity"])

    def test_efficacy_is_never_claimed(self):
        _, r = self.build()
        for rec in r["recipes"]:
            self.assertFalse(rec["efficacy"]["estimated"])

    def test_square_root_formula_is_the_documented_one(self):
        _, r = self.build()
        exprs = [f["expr"] for f in r["formulas"]]
        self.assertIn("Q(p) = Q₃ · √(p / 3)", exprs)
        n = load_catalog().nozzle("WRC110025")       # ugello con un solo punto di catalogo
        self.assertTrue(n.estimated)
        q3 = n.flow(3.0)
        self.assertAlmostEqual(n.flow(5.0), q3 * math.sqrt(5.0 / 3.0), delta=0.02)


class Matching(unittest.TestCase):
    def body(self, recipe, cfg):
        return {"task": 0, "products": [product()], "options": {}, "recipe_id": recipe, "config": cfg}

    def test_levels(self):
        s = session()
        self.assertEqual(service.match_payload(s, self.body("aderente", BARE))["level"], "insufficiente")
        self.assertEqual(service.match_payload(s, self.body("aderente", VALVE_ONLY))["level"], "adeguata")
        self.assertNotEqual(service.match_payload(s, self.body("uniforme", BARE))["level"], "insufficiente")
        rows = {r["id"]: r for r in service.match_payload(s, self.body("aderente", BARE))["rows"]}
        self.assertEqual(rows["vra"]["status"], "fail")
        self.assertEqual(rows["sections"]["status"], "unknown")

    def test_arag_recommendations_are_catalog_products_and_recomputed(self):
        s = session()
        rec = service.recommend_payload(s, self.body("aderente", BARE))
        self.assertTrue(rec["recommendations"])
        cat = load_catalog()
        first = rec["recommendations"][0]
        self.assertEqual(first["group"], "indispensabile")
        self.assertNotEqual(first["after"]["level"], "insufficiente")
        for r in rec["recommendations"]:
            for it in r["items"]:
                self.assertIsNotNone(cat.get(it["product"]["code"]))
            # il guadagno dichiarato coincide con un nuovo calcolo sulla configurazione proposta
            again = service.match_payload(s, self.body("aderente", {**BARE, **r["changes"]}))
            self.assertAlmostEqual(again["kpi"]["on_target_pct"], r["after"]["on_target_pct"], delta=0.01)

    def test_nothing_proposed_when_not_needed_or_explained(self):
        rec = service.recommend_payload(session(), self.body("aderente", VALVE_ONLY))
        self.assertEqual(rec["level"], "adeguata")
        for r in rec["recommendations"]:
            self.assertNotEqual(r["group"], "indispensabile")


class Dossier(unittest.TestCase):
    def body(self, **kw):
        b = {"task": 0, "products": [product()], "options": {}, "config": VALVE_ONLY}
        b.update(kw)
        return b

    def test_status_transitions(self):
        s = session()
        self.assertEqual(service.dossier_payload(s, self.body())["status"], "bozza")
        d = service.dossier_payload(s, self.body(recipe_id="risparmio"))
        self.assertEqual(d["status"], "da_completare")
        self.assertTrue(d["missing"])
        d = service.dossier_payload(s, self.body(recipe_id="risparmio", operator=OPERATOR))
        self.assertEqual(d["status"], "da_verificare")
        d = service.dossier_payload(s, self.body(recipe_id="risparmio", operator=OPERATOR, declarations=DECL,
                                                 validation={"name": "Tecnico", "confirm": True, "at": "oggi"}))
        self.assertEqual(d["status"], "validato")

    def test_validation_refused_for_unsuitable_hardware_or_non_compliant_recipe(self):
        s = session()
        full = dict(operator=OPERATOR, declarations=DECL, validation={"name": "Tecnico", "confirm": True})
        d = service.dossier_payload(s, self.body(recipe_id="aderente", config=BARE, **full))
        self.assertEqual(d["status"], "da_verificare")
        d = service.dossier_payload(s, self.body(recipe_id="aderente", **full))     # A non conforme all'etichetta
        self.assertEqual(d["status"], "da_verificare")
        self.assertTrue(any("non conforme" in t for t in d["to_validate"]))

    def test_executed_mode_requires_actual_quantities(self):
        s = session()
        d = service.dossier_payload(s, self.body(recipe_id="risparmio", operator={**OPERATOR, "date_done": "2026-10-13"}, mode="eseguito"))
        self.assertTrue(any("effettiv" in m for m in d["missing"]))

    def test_exports(self):
        s = session()
        data, ctype, name = service.dossier_file(s, self.body(recipe_id="risparmio", format="json", map_png="data:image/png;base64,AAAA"))
        self.assertIn("json", ctype)
        obj = json.loads(data)
        self.assertNotIn("map_png", obj)
        self.assertEqual(obj["kind"], "um-dossier")
        bad = 'data:image/png;base64,AAAA"><script>alert(1)</script>'
        html, _, _ = service.dossier_file(s, self.body(recipe_id="risparmio", map_png=bad))
        self.assertNotIn(b"<script>alert", html)
        html, ctype, _ = service.dossier_file(s, self.body(recipe_id="risparmio"))
        self.assertIn("text/html", ctype)
        self.assertIn("non attesta la conformità".encode(), html)


class GeoJson(unittest.TestCase):
    def test_build_prescription_from_index_map(self):
        s = service.Session(sid="g")
        info = service.geojson_inspect(ndvi_geojson())
        self.assertEqual(info["properties"][0]["name"], "NDVI")
        out = service.geojson_load(s, ndvi_geojson(), "ndvi.geojson", {"property": "NDVI", "classes": 4, "vol_low": 150, "vol_high": 300})
        t = out["summary"]["tasks"][0]
        self.assertEqual(t["kind"], "zones_geo")
        rates = sorted(c["rate"] for c in t["classes"])
        self.assertEqual(len(rates), 4)
        self.assertAlmostEqual(rates[0], 150, delta=0.01)
        self.assertAlmostEqual(rates[-1], 300, delta=0.01)
        self.assertEqual(out["origin"]["boundary"], "hull")
        # la prescrizione creata passa per tutta la pipeline ed è esportabile
        z = service.zoning_payload(s, {"task": 0})
        self.assertTrue(any(p["what"] == "Mappa indice" for p in z["provenance"]["acquired"]))
        data, _, summ = service.build_export(s, {"config": FULL, "approve": True})
        self.assertTrue(zipfile.ZipFile(io.BytesIO(data)).namelist())

    def test_direction_boundary_and_rejections(self):
        s = service.Session(sid="g")
        out = service.geojson_load(s, ndvi_geojson(boundary=True), "b.geojson",
                                   {"property": "NDVI", "classes": 2, "vol_low": 100, "vol_high": 200, "direction": "down"})
        self.assertEqual(out["origin"]["boundary"], "file")
        cls = sorted(out["origin"]["class_table"], key=lambda c: c["index_mean"])
        self.assertGreater(cls[0]["rate"], cls[-1]["rate"])
        with self.assertRaises(service.ServiceError):
            service.geojson_inspect(ndvi_geojson(crs="urn:ogc:def:crs:EPSG::32632"))
        with self.assertRaises(service.ServiceError):
            service.geojson_inspect(ndvi_geojson(scale=50000))       # coordinate proiettate
        with self.assertRaises(service.ServiceError):
            service.geojson_load(s, ndvi_geojson(), "x.geojson", {"property": "NDVI", "classes": 3})   # volumi non indicati
        with self.assertRaises(geoimport.GeoImportError):
            geoimport.inspect(b"{not json")


class ExportWithRecipe(unittest.TestCase):
    def test_uniform_recipe_rewrites_and_verifies(self):
        s = session()
        rs = service.recipes_payload(s, {"task": 0, "products": [product()], "options": {}, "config": FULL})
        uni = rs["recipes"][2]
        rates = {str(z["i"]): z["volume"] for z in uni["zones"] if z["volume"]}
        with self.assertRaises(service.ServiceError):          # cambia i ratei: serve la conferma
            service.build_export(s, {"config": FULL, "task": 0, "rates": rates})
        data, _, summ = service.build_export(s, {"config": FULL, "task": 0, "rates": rates, "approve": True})
        self.assertGreater(summ["changed_classes"], 0)
        rx = isoxml.analyse(isoxml.read_package(data, "out.zip"))
        vals = {round(k.rate, 1) for k in rx.tasks[0].classes if k.rate}
        self.assertEqual(len(vals), 1)
        self.assertAlmostEqual(vals.pop(), uni["volume_mean"], delta=1.0)

    def test_bad_rates_rejected(self):
        s = session()
        with self.assertRaises(service.ServiceError):
            service.evaluate_payload(s, {"task": 0, "config": FULL, "rates": {"0": 5000}})


class PipelineHttp(ServerCase):
    def test_endpoints(self):
        c = self.client()
        self.assertEqual(c.post_json("/api/example", {"id": "zone_poligonali"})[0], 200)
        base = {"task": 0, "products": [product()], "options": {"tank_l": 2000}, "config": FULL}
        st, _, body = c.post_json("/api/zoning", {"task": 0})
        self.assertEqual(st, 200, body)
        st, _, body = c.post_json("/api/recipes", base)
        self.assertEqual(st, 200, body)
        self.assertEqual(len(json.loads(body)["recipes"]), 3)
        for path in ("/api/match", "/api/recommend", "/api/dossier"):
            st, _, body = c.post_json(path, {**base, "recipe_id": "risparmio"})
            self.assertEqual(st, 200, (path, body))
        st, h, body = c.post_json("/api/dossier/file", {**base, "recipe_id": "risparmio", "format": "json"})
        self.assertEqual(st, 200)
        self.assertIn("attachment", h["Content-Disposition"])
        st, _, body = c.post_json("/api/match", {**base, "recipe_id": "inesistente"})
        self.assertEqual(st, 400)
        st, _, body = c.req("GET", "/api/satellite")
        self.assertFalse(json.loads(body)["configured"])

    def test_geojson_upload(self):
        c = self.client()
        st, _, body = c.req("POST", "/api/geojson/inspect", ndvi_geojson(), {"Content-Type": "application/octet-stream", "X-Filename": "m.geojson"})
        self.assertEqual(st, 200, body)
        params = urllib.parse.quote(json.dumps({"property": "NDVI", "classes": 3, "vol_low": 150, "vol_high": 300}))
        st, _, body = c.req("POST", "/api/geojson/load", ndvi_geojson(), {"Content-Type": "application/octet-stream", "X-Filename": "m.geojson", "X-Params": params})
        self.assertEqual(st, 200, body)
        self.assertEqual(json.loads(body)["origin"]["kind"], "geojson")
        st, _, body = c.req("GET", "/api/session")
        self.assertEqual(json.loads(body)["origin"]["kind"], "geojson")


if __name__ == "__main__":
    unittest.main()
