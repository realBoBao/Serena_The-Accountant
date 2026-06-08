```python
from manim import *

class QuickSortAnimation(Scene):
    def construct(self):
        # Title
        title = Text("QuickSort", font_size=48).to_edge(UP)
        self.play(Write(title))
        self.wait(1)

        # Initial array
        array_values = [5, 2, 8, 1, 9, 4]
        array_mobjects = VGroup(*[
            Square(side_length=1).add(Text(str(val), font_size=32))
            for val in array_values
        ]).arrange(RIGHT, buff=0.1).next_to(title, DOWN, buff=1)

        labels = VGroup(*[
            Text(f"[{i}]", font_size=24).next_to(array_mobjects[i], DOWN, buff=0.1)
            for i in range(len(array_values))
        ])

        self.play(Create(array_mobjects), Create(labels))
        self.wait(1)

        # Explanation of Pivot
        pivot_text = Text("Chọn phần tử chốt (Pivot)", font_size=32).to_edge(LEFT).shift(UP*1.5)
        self.play(Write(pivot_text))
        self.wait(0.5)

        # Highlight pivot (e.g., last element)
        pivot_index = len(array_values) - 1
        pivot_box = SurroundingRectangle(array_mobjects[pivot_index], color=YELLOW, buff=0.1)
        pivot_label = Text("Pivot", font_size=28, color=YELLOW).next_to(pivot_box, UP)
        self.play(Create(pivot_box), Write(pivot_label))
        self.wait(1)

        # Partitioning idea
        partition_text = Text("Phân hoạch mảng", font_size=32).next_to(pivot_text, DOWN, buff=0.5).align_to(pivot_text, LEFT)
        self.play(Write(partition_text))
        self.wait(0.5)

        # Simulate a simple swap for demonstration
        # For a full QuickSort, this would be a loop with multiple swaps
        # Here, we just show the concept of moving smaller elements
        
        # Example: Move '2' (index 1) before '5' (index 0, if 5 was pivot)
        # For simplicity, let's just show '2' moving to the left of '5'
        # This is a simplified visual, not a full partition step
        
        # Let's highlight elements smaller than pivot (4)
        # Pivot is 4 (index 5)
        
        smaller_elements_group = VGroup()
        for i in range(len(array_values) - 1): # Exclude pivot
            if array_values[i] < array_values[pivot_index]:
                smaller_elements_group.add(array_mobjects[i])
        
        if smaller_elements_group:
            self.play(
                *[array_mobject.animate.set_color(BLUE) for array_mobject in smaller_elements_group],
                run_time=0.5
            )
            self.wait(0.5)
            self.play(
                *[array_mobject.animate.set_color(WHITE) for array_mobject in smaller_elements_group],
                run_time=0.5
            )

        # Final state (simplified)
        final_text = Text("Lặp lại cho các mảng con", font_size=32).next_to(partition_text, DOWN, buff=0.5).align_to(pivot_text, LEFT)
        self.play(Write(final_text))
        self.wait(1)

        # Remove elements
        self.play(
            FadeOut(array_mobjects),
            FadeOut(labels),
            FadeOut(pivot_box),
            FadeOut(pivot_label),
            FadeOut(pivot_text),
            FadeOut(partition_text),
            FadeOut(final_text)
        )

        # Conclusion
        conclusion = Text("Sắp xếp nhanh và hiệu quả!", font_size=36, color=GREEN).next_to(title, DOWN, buff=1)
        self.play(Write(