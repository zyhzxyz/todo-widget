import unittest

from tools.check_tauri_versions import compatibility_errors


class TauriVersionTests(unittest.TestCase):
    def setUp(self):
        self.npm = {
            "packages": {
                "": {"dependencies": {"@tauri-apps/api": "^2", "@tauri-apps/plugin-notification": "^2"}},
                "node_modules/@tauri-apps/api": {"version": "2.11.0"},
                "node_modules/@tauri-apps/plugin-notification": {"version": "2.4.0"},
            }
        }
        self.cargo = {"package": [
            {"name": "tauri", "version": "2.11.5"},
            {"name": "tauri-plugin-notification", "version": "2.4.0"},
        ]}

    def test_patch_differences_are_allowed(self):
        self.assertEqual(compatibility_errors(self.npm, self.cargo), [])

    def test_notification_minor_drift_is_rejected(self):
        self.npm["packages"]["node_modules/@tauri-apps/plugin-notification"]["version"] = "2.3.3"
        errors = compatibility_errors(self.npm, self.cargo)
        self.assertEqual(len(errors), 1)
        self.assertIn("@tauri-apps/plugin-notification 2.3.3 != tauri-plugin-notification 2.4.0", errors[0])

    def test_major_drift_is_rejected(self):
        self.cargo["package"][0]["version"] = "3.11.0"
        self.assertIn("@tauri-apps/api", compatibility_errors(self.npm, self.cargo)[0])

    def test_missing_native_or_frontend_package_is_rejected(self):
        self.cargo["package"].pop()
        self.assertIn("missing from Cargo.lock", compatibility_errors(self.npm, self.cargo)[0])
        del self.npm["packages"]["node_modules/@tauri-apps/api"]
        self.assertEqual(len(compatibility_errors(self.npm, self.cargo)), 2)

    def test_native_only_plugins_and_cli_are_not_paired(self):
        self.npm["packages"][""]["devDependencies"] = {"@tauri-apps/cli": "^2"}
        self.cargo["package"].append({"name": "tauri-plugin-autostart", "version": "2.5.1"})
        self.assertEqual(compatibility_errors(self.npm, self.cargo), [])

    def test_multiple_incompatible_native_versions_are_not_silently_ignored(self):
        self.cargo["package"].append({"name": "tauri-plugin-notification", "version": "2.3.3"})
        self.assertEqual(len(compatibility_errors(self.npm, self.cargo)), 1)

    def test_empty_dependency_list_is_not_a_success(self):
        self.npm["packages"][""]["dependencies"] = {}
        self.assertIn("No frontend Tauri packages", compatibility_errors(self.npm, self.cargo)[0])


if __name__ == "__main__":
    unittest.main()
