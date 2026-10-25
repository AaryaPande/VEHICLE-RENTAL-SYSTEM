
const express = require('express');
const router = express.Router();
const db = require('./db');
console.log('LOADED ROUTES FILE:', __filename);
// MODULE 1: USER AUTHENTICATION (LOGIN)
router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await db.query(
            `SELECT user_id, username, email, role
             FROM Users
             WHERE email = ? AND password_hash = ?`,
            [email, password]
        );

        if (users.length === 0) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        const user = users[0];

        res.json({
            message: 'Login successful',
            user: {
                id: user.user_id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            error: 'Login failed'
        });
    }
});


// MODULE 3: GET AVAILABLE CSV200 VEHICLES


router.get('/vehicles', async (req, res) => {
    try {
        const [vehicles] = await db.query(`
            SELECT
                v.vehicle_id,
                v.make,
                v.model,
                v.manufacture_year AS year,
                v.registration_number AS license_plate,
                v.rental_rate_per_day AS base_price,
                COALESCE(v.adjusted_rate_per_day,
                         v.rental_rate_per_day) AS daily_rate,
                v.pricing_category,
                v.status,
                v.fuel_type,
                v.vehicle_type,
                v.city,
                v.country,
                v.rating,
                v.renter_trips_taken,
                v.review_count,
                v.latitude,
                v.longitude,
                v.state,
                v.dataset_source,

                COALESCE(rs.reliability_score, 0) AS reliability_score,

LEAST(100, GREATEST(0,
    (YEAR(CURDATE()) - COALESCE(v.manufacture_year, YEAR(CURDATE()))) * 2
)) AS age_penalty,

LEAST(100, GREATEST(0,
    COALESCE((
        SELECT SUM(
            CASE
                WHEN LOWER(d.severity) = 'critical' THEN 25
                WHEN LOWER(d.severity) = 'major' THEN 20
                WHEN LOWER(d.severity) = 'moderate' THEN 10
                WHEN LOWER(d.severity) = 'minor' THEN 3
                ELSE 5
            END
        )
        FROM damage_reports d
        WHERE d.vehicle_id = v.vehicle_id
    ), 0)
)) AS damage_penalty,

LEAST(100, GREATEST(0,
    COALESCE((
        SELECT SUM(
            CASE
                WHEN m.service_type = 'Breakdown Fix' THEN 10
                WHEN m.service_type = 'Repair' THEN 7
                WHEN m.service_type = 'Inspection' THEN 2
                WHEN m.service_type = 'Routine Servicing' THEN 1
                ELSE 3
            END
        )
        FROM maintenance_records m
        WHERE m.vehicle_id = v.vehicle_id
          AND m.service_date >= DATE_SUB(CURDATE(), INTERVAL 2 YEAR)
    ), 0)
)) AS maintenance_penalty,

                (
                    SELECT COUNT(*)
                    FROM vehicles v2
                    WHERE v2.make = v.make
                      AND v2.model = v.model
                      AND v2.status = 'Available'
                      AND v2.dataset_source = 'CSV200'
                ) AS available_quantity

            FROM vehicles v
            LEFT JOIN reliability_scores rs
                ON rs.vehicle_id = v.vehicle_id
            WHERE v.dataset_source = 'CSV200'
              AND v.status = 'Available'
            ORDER BY v.vehicle_id
        `);

        res.json(vehicles);
    } catch (err) {
        console.error('Vehicles route error:', err);
        res.status(500).json({
            error: 'Failed to fetch vehicles',
            details: err.message
        });
    }
});


// MODULE 4: CREATE A BOOKING

router.post('/bookings', async (req, res) => {
    const {
        customer_id,
        vehicle_id,
        start_date,
        end_date
    } = req.body;

    const customerId = Number(customer_id);
    const vehicleId = Number(vehicle_id);

    if (
        !Number.isInteger(customerId) || customerId <= 0 ||
        !Number.isInteger(vehicleId) || vehicleId <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '') ||
        end_date < start_date
    ) {
        return res.status(400).json({
            error: 'Please enter valid customer, vehicle, and rental dates.'
        });
    }

    try {
        await db.query(
            'CALL Recalculate_Vehicle_Reliability(?)',
            [vehicleId]
        );

        const [vehicles] = await db.query(`
            SELECT
                v.status,
                v.rental_rate_per_day,
                rs.reliability_score
            FROM vehicles v
            LEFT JOIN reliability_scores rs
                ON rs.vehicle_id = v.vehicle_id
            WHERE v.vehicle_id = ?
              AND v.dataset_source = 'CSV200'
              AND v.status = 'Available'
        `, [vehicleId]);

        if (vehicles.length === 0) {
            return res.status(400).json({
                error: 'Vehicle is unavailable or not part of the active dataset.'
            });
        }

        const score = Number(vehicles[0].reliability_score);
        const baseRate = Number(vehicles[0].rental_rate_per_day);

        if (!Number.isFinite(score) || !Number.isFinite(baseRate)) {
            return res.status(400).json({
                error: 'Vehicle pricing information is unavailable.'
            });
        }

        let adjustment;

        if (score >= 90) adjustment = 0.10;
        else if (score >= 80) adjustment = 0;
        else if (score >= 70) adjustment = -0.10;
        else if (score >= 60) adjustment = -0.20;
        else {
            return res.status(400).json({
                error: 'Vehicle requires inspection before rental.'
            });
        }

        const dailyRate = Math.round(
            baseRate * (1 + adjustment) * 100
        ) / 100;

        const startTime = Date.parse(start_date + 'T00:00:00Z');
        const endTime = Date.parse(end_date + 'T00:00:00Z');

        const rentalDays = Math.floor(
            (endTime - startTime) / 86400000
        ) + 1;

        const totalCost = Math.round(
            dailyRate * rentalDays * 100
        ) / 100;

        const [result] = await db.query(`
            INSERT INTO Bookings
                (customer_id, vehicle_id, start_date, end_date,
                 total_cost, booking_status)
            VALUES (?, ?, ?, ?, ?, 'Confirmed')
        `, [
            customerId,
            vehicleId,
            start_date,
            end_date,
            totalCost
        ]);

        res.json({
            message: 'Booking confirmed',
            booking_id: result.insertId,
            rental_days: rentalDays,
            daily_rate: dailyRate,
            total_cost: totalCost
        });
    } catch (err) {
        console.error('Booking error:', err);

        res.status(500).json({
            error: 'Failed to create booking'
        });
    }
});



// MODULE 7: GET DAMAGE & INSPECTION REPORTS
router.get('/damage-reports', async (req, res) => {
    try {
        const [reports] = await db.query(`
            SELECT
                d.*,
                v.make,
                v.model
            FROM Damage_Reports d
            LEFT JOIN Vehicles v
                ON d.vehicle_id = v.vehicle_id
            ORDER BY d.damage_id DESC
        `);

        res.json(reports);
    } catch (err) {
        console.error('Damage reports error:', err);

        res.status(500).json({
            error: 'Failed to fetch damage reports'
        });
    }
});


 // MODULE 9: GET VEHICLE RELIABILITY SCORE

router.get('/vehicles/:id/reliability', async (req, res) => {
  try {
    const vehicleId = Number(req.params.id);

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ message: 'Invalid vehicle ID.' });
    }

    // Recalculate the reliability score and its individual penalties
    await db.query(
      'CALL Recalculate_Vehicle_Reliability(?)',
      [vehicleId]
    );

    // Return the score and all three penalties
    
const [rows] = await db.query(
  `SELECT
     vehicle_id,
     reliability_score,
     damage_penalty,
     age_penalty,
     maintenance_penalty,
     last_updated AS last_calculated
   FROM reliability_scores
   WHERE vehicle_id = ?
   ORDER BY score_id DESC
   LIMIT 1`,
  [vehicleId]
);


    if (!rows.length) {
      return res.status(404).json({
        message: 'Reliability details not found for this vehicle.'
      });
    }

    res.json(rows[0]);

  } catch (error) {
    console.error('Reliability API error:', error);

    res.status(500).json({
      message: 'Unable to load vehicle reliability details.'
    });
  }
});



// ADMIN: GET ALL CUSTOMERS
router.get('/admin/customers', async (req, res) => {
    try {
        console.log('CUSTOMERS ROUTE HIT');
        const [dbInfo] = await db.query(
    'SELECT DATABASE() AS db, COUNT(*) AS total FROM customers'
);
console.log('Backend database:', dbInfo[0]);
const [customers] = await db.query(`
    SELECT
        c.customer_id,
        c.full_name,
        COALESCE(c.email, u.email) AS email,
        c.phone,
        c.license_number,
        c.address,
        c.user_id
    FROM customers c
    LEFT JOIN users u ON c.user_id = u.user_id
    ORDER BY c.customer_id
`);

        res.json(customers);
    } catch (err) {
        console.error('Customers error:', err);

        res.status(500).json({
            error: 'Failed to fetch customer details'
        });
    }
});


// ADMIN: GET CUSTOMER, BOOKING, RENTAL AND PAYMENT DETAILS
router.get('/admin/customers/:id/details', async (req, res) => {
    try {
        const customerId = Number(req.params.id);

        if (!Number.isInteger(customerId) || customerId <= 0) {
            return res.status(400).json({
                error: 'Invalid customer ID'
            });
        }

        const [customers] = await db.query(`
    SELECT
        c.customer_id,
        c.full_name,
        COALESCE(c.email, u.email) AS email,
        c.phone,
        c.license_number,
        c.address,
        c.user_id
    FROM customers c
    LEFT JOIN users u ON c.user_id = u.user_id
    WHERE c.customer_id = ?
`, [customerId]);
        if (customers.length === 0) {
            return res.status(404).json({
                error: 'Customer not found'
            });
        }

        const [bookings] = await db.query(`
            SELECT
                b.booking_id,
                v.make,
                v.model,
                b.start_date,
                b.end_date,
                b.total_cost,
                b.booking_status
            FROM bookings b
            JOIN vehicles v
                ON b.vehicle_id = v.vehicle_id
            WHERE b.customer_id = ?
            ORDER BY b.booking_date DESC
        `, [customerId]);

        const [rentals] = await db.query(`
            SELECT
                r.rental_id,
                r.booking_id,
                r.pickup_datetime,
                r.return_datetime,
                r.odometer_start,
                r.odometer_end,
                r.rental_status
            FROM rentals r
            JOIN bookings b
                ON r.booking_id = b.booking_id
            WHERE b.customer_id = ?
            ORDER BY r.pickup_datetime DESC
        `, [customerId]);

        const [payments] = await db.query(`
            SELECT
                p.payment_id,
                p.booking_id,
                p.payment_date,
                p.amount_paid,
                p.payment_method,
                p.payment_status
            FROM payments p
            JOIN bookings b
                ON p.booking_id = b.booking_id
            WHERE b.customer_id = ?
            ORDER BY p.payment_date DESC
        `, [customerId]);

        res.json({
            customer: customers[0],
            bookings,
            rentals,
            payments
        });
    } catch (err) {
        console.error('Customer details error:', err);

        res.status(500).json({
            error: 'Failed to fetch customer details'
        });
    }
});


// MODULE: CALCULATE RELIABILITY-BASED RENTAL PRICE
router.get('/vehicles/:id/pricing', async (req, res) => {
    try {
        const vehicleId = Number(req.params.id);

        if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
            return res.status(400).json({
                error: 'Invalid vehicle ID'
            });
        }

        // Only calculate prices for vehicles in the active dataset.
        await db.query(
            'CALL Recalculate_Vehicle_Reliability(?)',
            [vehicleId]
        );

        
const [vehicles] = await db.query(`
    SELECT
        v.vehicle_id,
        v.make,
        v.model,
        v.rental_rate_per_day,
        v.status,
        rs.reliability_score,
        rs.last_updated AS last_calculated
    FROM vehicles v
    LEFT JOIN reliability_scores rs
        ON v.vehicle_id = rs.vehicle_id
    WHERE v.vehicle_id = ?
        AND v.dataset_source = 'CSV200'
`, [vehicleId]);

        if (vehicles.length === 0) {
            return res.status(404).json({
                error: 'Vehicle not found in the active dataset'
            });
        }

        const vehicle = vehicles[0];
        const score = Number(vehicle.reliability_score);
        const basePrice = Number(vehicle.rental_rate_per_day);

        if (
            !Number.isFinite(score) ||
            !Number.isFinite(basePrice)
        ) {
            return res.status(500).json({
                error: 'Missing reliability score or base price'
            });
        }

        let adjustment;
        let category;

        if (score >= 90) {
            adjustment = 0.10;
            category = 'Excellent';
        } else if (score >= 80) {
            adjustment = 0;
            category = 'Good';
        } else if (score >= 70) {
            adjustment = -0.10;
            category = 'Moderate';
        } else if (score >= 60) {
            adjustment = -0.20;
            category = 'Low';
        } else {
            return res.json({
                vehicle_id: vehicle.vehicle_id,
                vehicle: `${vehicle.make} ${vehicle.model}`,
                reliability_score: score,
                base_price: basePrice,
                adjusted_price: null,
                price_adjustment_percent: null,
                reliability_category: 'Inspection Required',
                rentable: false,
                message: 'Vehicle requires inspection before rental.'
            });
        }

        const adjustedPrice = Math.round(
            basePrice * (1 + adjustment) * 100
        ) / 100;

        res.json({
            vehicle_id: vehicle.vehicle_id,
            vehicle: `${vehicle.make} ${vehicle.model}`,
            reliability_score: score,
            base_price: basePrice,
            price_adjustment_percent: adjustment * 100,
            adjusted_price: adjustedPrice,
            reliability_category: category,
            rentable: vehicle.status === 'Available'
        });
    } catch (err) {
        console.error('Pricing calculation error:', err);

        res.status(500).json({
            error: 'Failed to calculate vehicle pricing',
            details: err.message
        });
    }
});


/* MODULE: DEMO PAYMENT PROCESSING */
router.post('/payments/demo', async (req, res) => {
    const bookingId = Number(req.body.booking_id);
    const method = String(req.body.payment_method || '').toLowerCase();

    const allowedMethods = [
        'upi',
        'credit_card',
        'debit_card',
        'cash'
    ];

    if (
        !Number.isInteger(bookingId) ||
        bookingId <= 0 ||
        !allowedMethods.includes(method)
    ) {
        return res.status(400).json({
            error: 'Invalid booking ID or payment method.'
        });
    }

    try {
        // Get the actual booking amount from the database.
        const [bookings] = await db.query(
            `SELECT booking_id, total_cost, booking_status
             FROM bookings
             WHERE booking_id = ?`,
            [bookingId]
        );

        if (bookings.length === 0) {
            return res.status(404).json({
                error: 'Booking not found.'
            });
        }

        const booking = bookings[0];
        const amount = Number(booking.total_cost);

        if (!Number.isFinite(amount) || amount < 0) {
            return res.status(400).json({
                error: 'Invalid booking amount.'
            });
        }

        // Cash is not paid until it is collected at pickup.
        const paymentStatus = method === 'cash'
            ? 'Pending'
            : 'Paid';

        // This is a DEMO. "Paid" means simulated success only.
        const amountPaid = method === 'cash' ? 0 : amount;

        // Reuse an existing payment record for this booking,
        // if one exists, instead of creating duplicates.
        const [existing] = await db.query(
            `SELECT payment_id
             FROM payments
             WHERE booking_id = ?
             ORDER BY payment_id DESC
             LIMIT 1`,
            [bookingId]
        );

        let paymentId;

        if (existing.length > 0) {
            paymentId = existing[0].payment_id;

            await db.query(
                `UPDATE payments
                 SET amount_paid = ?,
                     payment_method = ?,
                     payment_status = ?,
                     payment_date = CURRENT_TIMESTAMP
                 WHERE payment_id = ?`,
                [amountPaid, method, paymentStatus, paymentId]
            );
        } else {
            const [result] = await db.query(
                `INSERT INTO payments
                    (booking_id, payment_date, amount_paid,
                     payment_method, payment_status)
                 VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)`,
                [bookingId, amountPaid, method, paymentStatus]
            );

            paymentId = result.insertId;
        }

        res.json({
            message: method === 'cash'
                ? 'Cash payment recorded. Collect payment at vehicle pickup.'
                : 'Demo payment successful. No real money was charged.',
            booking_id: bookingId,
            payment_id: paymentId,
            payment_method: method,
            amount_due: amount,
            amount_paid: amountPaid,
            payment_status: paymentStatus,
            demo: method !== 'cash'
        });
    } catch (err) {
        console.error('Demo payment error:', err);

        res.status(500).json({
            error: 'Failed to record payment.',
            details: err.message
        });
    }
});


/* ADMIN: RECORD CASH COLLECTION AT PICKUP */
router.patch('/admin/payments/:id/collect-cash', async (req, res) => {
    const paymentId = Number(req.params.id);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
        return res.status(400).json({
            error: 'Invalid payment ID.'
        });
    }

    try {
        const [result] = await db.query(
            `UPDATE payments
             SET payment_status = 'Paid',
                 amount_paid = (
                     SELECT total_cost
                     FROM bookings
                     WHERE bookings.booking_id = payments.booking_id
                 ),
                 payment_date = CURRENT_TIMESTAMP
             WHERE payment_id = ?
               AND LOWER(payment_method) = 'cash'
               AND payment_status = 'Pending'`,
            [paymentId]
        );

        if (result.affectedRows === 0) {
            return res.status(400).json({
                error: 'No pending cash payment found for this payment ID.'
            });
        }

        res.json({
            message: 'Cash collection recorded.',
            payment_id: paymentId,
            payment_status: 'Paid'
        });
    } catch (err) {
        console.error('Cash collection error:', err);
        res.status(500).json({
            error: 'Failed to record cash collection.'
        });
    }
});


module.exports = router;
