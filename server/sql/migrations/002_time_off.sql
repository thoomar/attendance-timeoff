DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'time_off_status') THEN
CREATE TYPE time_off_status AS ENUM ('PENDING','APPROVED','REJECTED');
END IF;
END $$;

CREATE TABLE IF NOT EXISTS time_off_requests (
                                                 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_user_id uuid NOT NULL,
    manager_user_id uuid NULL,
    date date NOT NULL,
    reason text NOT NULL,
    status time_off_status NOT NULL DEFAULT 'PENDING',
    decided_by uuid NULL,
    decided_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
    );

CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests(employee_user_id);
CREATE INDEX IF NOT EXISTS idx_time_off_requests_date ON time_off_requests(date);
CREATE INDEX IF NOT EXISTS idx_time_off_requests_status ON time_off_requests(status);
