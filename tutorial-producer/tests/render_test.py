import importlib.util, unittest
spec=importlib.util.spec_from_file_location('render','tutorial-producer/render.py'); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class RenderSafety(unittest.TestCase):
    def test_failed_capture_cannot_export(self):
        with self.assertRaises(ValueError): module.validate({'status':'fail','scenes':[]})
    def test_partially_verified_capture_cannot_export(self):
        with self.assertRaises(ValueError): module.validate({'status':'pass','scenes':[{'verification_status':'fail'}]})
    def test_verified_scene_without_narration_cannot_export(self):
        with self.assertRaises(ValueError): module.validate({'status':'pass','scenes':[{'verification_status':'pass','screenshot_paths':['proof.png']}]})
if __name__=='__main__': unittest.main()
