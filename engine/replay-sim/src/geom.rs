use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Vec2 { x, y }
    }

    pub fn length_squared(self) -> f64 {
        self.x * self.x + self.y * self.y
    }

    pub fn length(self) -> f64 {
        self.length_squared().sqrt()
    }

    /// Multiplies by the reciprocal, as the reference engine does.
    pub fn normalize(self) -> Vec2 {
        if self.length_squared() < 1e-18 {
            Vec2::new(0.0, 0.0)
        } else {
            self * (1.0 / self.length())
        }
    }

    /// Truncates both components toward zero, like a C# (int) cast.
    pub fn truncate(self) -> Vec2 {
        Vec2::new(trunc_i32(self.x) as f64, trunc_i32(self.y) as f64)
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, b: Vec2) -> Vec2 {
        Vec2::new(self.x + b.x, self.y + b.y)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, b: Vec2) -> Vec2 {
        Vec2::new(self.x - b.x, self.y - b.y)
    }
}

impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, b: f64) -> Vec2 {
        Vec2::new(self.x * b, self.y * b)
    }
}

/// A C# (int) cast for values in range; out-of-range values saturate.
pub fn trunc_i32(value: f64) -> i32 {
    value as i32
}
