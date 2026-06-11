from manim import *

class GeneratedAnimation(Scene):
    def construct(self):
        # Title
        title = Text("test animation", font_size=32)
        self.play(Write(title))
        self.wait(1)

        # Content placeholder
        content = Text("Animation: test animation", font_size=24, color=BLUE)
        content.next_to(title, DOWN, buff=0.5)
        self.play(FadeIn(content))
        self.wait(1)

        # Summary box
        box = SurroundingRectangle(content, color=YELLOW, buff=0.3)
        self.play(Create(box))
        self.wait(1)

        # End
        self.play(FadeOut(title), FadeOut(content), FadeOut(box))
        self.wait(0.5)
