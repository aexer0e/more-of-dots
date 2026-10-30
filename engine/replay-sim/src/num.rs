//! Arithmetic that reproduces the game's Python and NumPy results bit for bit.

use num_bigint::BigInt;
use num_traits::{One, ToPrimitive, Zero};
use std::cmp::Ordering;

const POW10: [f64; 10] = [1.0, 10.0, 100.0, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/// NumPy's round: scale, round half to even, unscale.
pub fn numpy_round(value: f64, digits: usize) -> f64 {
    let scale = POW10[digits];
    (value * scale).round_ties_even() / scale
}

fn parts(value: f64) -> (u64, i32) {
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mut mantissa = bits & 0x000f_ffff_ffff_ffff;
    if exponent != 0 {
        mantissa |= 1 << 52;
    }
    (mantissa, if exponent == 0 { -1074 } else { exponent - 1023 - 52 })
}

/// Python's round(float, digits) rounds the exact binary input. Multiplying
/// by 10^digits first can turn a nearby value into a tie, as with 2.675.
pub fn python_round(value: f64, digits: usize) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let negative = value.is_sign_negative();
    let (significand, exponent) = parts(value);
    let pow10 = 10u128.pow(digits as u32);
    let rounded = if exponent < 0 && exponent > -120 && digits <= 9 {
        let numerator = significand as u128 * pow10;
        let shift = (-exponent) as u32;
        let quotient = numerator >> shift;
        let remainder = numerator & ((1u128 << shift) - 1);
        let twice = remainder << 1;
        let half = 1u128 << shift;
        let quotient = if twice > half || (twice == half && quotient & 1 == 1) { quotient + 1 } else { quotient };
        quotient as f64 / POW10[digits]
    } else {
        let mut numerator = BigInt::from(significand) * BigInt::from(pow10);
        let mut denominator = BigInt::one();
        if exponent >= 0 {
            numerator <<= exponent as usize;
        } else {
            denominator <<= (-exponent) as usize;
        }
        let mut quotient = &numerator / &denominator;
        let remainder = &numerator % &denominator;
        let comparison = (remainder * 2u32).cmp(&denominator);
        if comparison == Ordering::Greater || (comparison == Ordering::Equal && (&quotient % 2u32) != BigInt::zero()) {
            quotient += 1u32;
        }
        quotient.to_f64().unwrap_or(f64::INFINITY) / 10f64.powi(digits as i32)
    };
    if negative {
        -rounded
    } else {
        rounded
    }
}

fn big_parts(value: f64) -> (BigInt, i32) {
    let (mantissa, exponent) = parts(value);
    (BigInt::from(mantissa), exponent)
}

fn compare_scaled(a: &BigInt, ae: i32, b: &BigInt, be: i32) -> Ordering {
    let common = ae.min(be);
    let left = a << ((ae - common) as usize);
    let right = b << ((be - common) as usize);
    left.cmp(&right)
}

/// Python's math.hypot, which returns the nearest binary64 root. The platform
/// hypot can differ by one ULP on replay collision vectors.
pub fn python_hypot(x: f64, y: f64) -> f64 {
    let x = x.abs();
    let y = y.abs();
    let mut result = x.hypot(y);
    if !result.is_finite() || result == 0.0 {
        return result;
    }
    let (xm, xe) = big_parts(x);
    let (ym, ye) = big_parts(y);
    let sum_exponent = (xe * 2).min(ye * 2);
    let sum = ((&xm * &xm) << ((xe * 2 - sum_exponent) as usize)) + ((&ym * &ym) << ((ye * 2 - sum_exponent) as usize));
    let compare_midpoint = |a: f64, b: f64| {
        let (am, ae) = big_parts(a);
        let (bm, be) = big_parts(b);
        let exponent = ae.min(be);
        let midpoint = (am << ((ae - exponent) as usize)) + (bm << ((be - exponent) as usize));
        compare_scaled(&sum, sum_exponent, &(&midpoint * &midpoint), (exponent - 1) * 2)
    };
    loop {
        let odd = result.to_bits() & 1 != 0;
        let previous = result.next_down();
        let next = result.next_up();
        let low = compare_midpoint(previous, result);
        if low == Ordering::Less || (low == Ordering::Equal && odd) {
            result = previous;
            continue;
        }
        if next.is_finite() {
            let high = compare_midpoint(result, next);
            if high == Ordering::Greater || (high == Ordering::Equal && odd) {
                result = next;
                continue;
            }
        }
        return result;
    }
}

/// The game's contiguous (living,living) @ (living,2) NumPy product uses the
/// SkylakeX small GEMM kernel. Its four-row reduction and final one/two-row
/// reduction combine the same eight lanes differently. Keep zero entries:
/// compacting the enemy list changes lane placement.
pub fn native_masked_matrix_sum(values: &[f64], row: usize) -> f64 {
    let n = values.len();
    if n < 16 || 2 * (n as i64) * (n as i64) > 1_000_000 {
        let mut serial = 0.0;
        for &value in values {
            serial += value;
        }
        return serial;
    }
    let mut lanes = [0.0f64; 8];
    for (i, &value) in values.iter().enumerate() {
        lanes[i & 7] += value;
    }
    if row < (n & !3) {
        ((lanes[0] + lanes[1]) + (lanes[2] + lanes[3])) + ((lanes[4] + lanes[5]) + (lanes[6] + lanes[7]))
    } else {
        ((lanes[0] + lanes[4]) + (lanes[2] + lanes[6])) + ((lanes[1] + lanes[5]) + (lanes[3] + lanes[7]))
    }
}

/// NumPy reduces each selected perimeter coordinate independently. Its small
/// pairwise kernel uses eight lanes, then adds the remainder.
pub fn sum_perimeter_offsets(values: &[f64]) -> f64 {
    if values.len() < 8 {
        let mut sum = -0.0;
        for &value in values {
            sum += value;
        }
        return sum;
    }
    let mut lanes = [0.0f64; 8];
    lanes.copy_from_slice(&values[..8]);
    let paired = values.len() & !7;
    for i in 8..paired {
        lanes[i & 7] += values[i];
    }
    let mut result = ((lanes[0] + lanes[1]) + (lanes[2] + lanes[3])) + ((lanes[4] + lanes[5]) + (lanes[6] + lanes[7]));
    for &value in &values[paired..] {
        result += value;
    }
    result
}
