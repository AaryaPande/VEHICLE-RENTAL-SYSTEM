USE vehiclerentaldb;

SELECT
    v.vehicle_id,
    v.make,
    v.model,
    COUNT(m.maintenance_id) AS total_services,
    COALESCE(SUM(m.cost), 0) AS total_maintenance_cost
FROM vehicles v
LEFT JOIN maintenance_records m
    ON v.vehicle_id = m.vehicle_id
GROUP BY
    v.vehicle_id,
    v.make,
    v.model
ORDER BY total_maintenance_cost DESC;

USE vehiclerentaldb;

SELECT
    booking_status,
    COUNT(*) AS total_bookings,
    SUM(total_cost) AS total_booking_value,
    AVG(total_cost) AS average_booking_value
FROM bookings
GROUP BY booking_status
ORDER BY total_bookings DESC;

USE vehiclerentaldb;

SELECT
    c.customer_id,
    c.full_name,
    v.make,
    v.model,
    b.booking_id,
    b.start_date,
    b.end_date,
    b.total_cost,
    b.booking_status
FROM customers c
INNER JOIN bookings b
    ON c.customer_id = b.customer_id
INNER JOIN vehicles v
    ON b.vehicle_id = v.vehicle_id
ORDER BY b.booking_date DESC;

