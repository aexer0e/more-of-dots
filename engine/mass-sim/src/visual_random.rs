//! MT19937 with Python's integer seeding and rejection sampling. Cosmetic only.

pub struct VisualRandom {
    state: [u32; 624],
    index: usize,
}

impl VisualRandom {
    pub fn new(seed: u32) -> VisualRandom {
        let mut state = [0u32; 624];
        state[0] = 19650218;
        for j in 1..624u32 {
            let previous = state[j as usize - 1];
            state[j as usize] = 1812433253u32.wrapping_mul(previous ^ (previous >> 30)).wrapping_add(j);
        }
        let mut i = 1usize;
        for _ in (1..=624).rev() {
            let previous = state[i - 1];
            state[i] = (state[i] ^ (previous ^ (previous >> 30)).wrapping_mul(1664525)).wrapping_add(seed);
            i += 1;
            if i >= 624 {
                state[0] = state[623];
                i = 1;
            }
        }
        for _ in (1..=623).rev() {
            let previous = state[i - 1];
            state[i] = (state[i] ^ (previous ^ (previous >> 30)).wrapping_mul(1566083941)).wrapping_sub(i as u32);
            i += 1;
            if i >= 624 {
                state[0] = state[623];
                i = 1;
            }
        }
        state[0] = 0x8000_0000;
        VisualRandom { state, index: 624 }
    }

    fn next(&mut self) -> u32 {
        if self.index >= 624 {
            for i in 0..624 {
                let y = (self.state[i] & 0x8000_0000) | (self.state[(i + 1) % 624] & 0x7fff_ffff);
                self.state[i] = self.state[(i + 397) % 624] ^ (y >> 1) ^ if y & 1 != 0 { 0x9908_b0df } else { 0 };
            }
            self.index = 0;
        }
        let mut value = self.state[self.index];
        self.index += 1;
        value ^= value >> 11;
        value ^= (value << 7) & 0x9d2c_5680;
        value ^= (value << 15) & 0xefc6_0000;
        value ^= value >> 18;
        value
    }

    pub fn vibration(&mut self) -> i32 {
        loop {
            let value = self.next() >> 30;
            if value < 3 {
                return value as i32 - 1;
            }
        }
    }
}
