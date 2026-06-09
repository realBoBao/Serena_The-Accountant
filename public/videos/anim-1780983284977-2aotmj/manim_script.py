from manim import *

class GeneratedAnimation(Scene):
    def construct(self):
        # Title
        title = Text("test animation", font_size=32)
        self.play(Write(title))
        self.wait(1)

        # Content placeholder
        content = Text("Animation: test animation", font_size=24) # Added missing closing parenthesis
        self.play(Write(content)) # Added animation for the content
        self.wait(2) # Added a wait at the end