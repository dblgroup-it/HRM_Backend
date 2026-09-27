/**
 * A complete BDJobs v2 application — every one of the 51 parameters on the
 * agreed list, filled in.
 *
 * Not test-only: this exact object is printed in the integration document
 * sent to BDJobs, and the spec runs it through the real mapper. The document
 * therefore cannot show a payload the server does not accept.
 *
 * `ts` is a placeholder: a live request must carry the current Unix time.
 */
export const BDJOBS_V2_EXAMPLE = {
  jobReferenceId: 'REQ-2026-008',
  bdJobsJobId: '1398245',
  applicationId: 'BDJ-APP-77410235',
  ts: 1790000000,

  candidate: {
    name: 'Md. Rakibul Hasan',
    email: 'rakibul.hasan@example.com',
    phone: '+880 1712345678',
  },

  // 1 · Profile picture
  photo: {
    url: 'https://images.bdjobs.com/photos/77410235.jpg',
    fileName: '77410235.jpg',
    mimeType: 'image/jpeg',
  },

  resume: {
    url: 'https://files.bdjobs.com/cv/77410235.pdf',
    fileName: 'Rakibul_Hasan_CV.pdf',
    mimeType: 'application/pdf',
  },

  CandidateData: {
    personalData: {
      // 2–7 · Basic & contact information
      fullName: 'Md. Rakibul Hasan',
      currentAddress1: 'House 12, Road 5, Block C',
      currentAddress2: 'Mirpur-10, Dhaka-1216',
      permanentAddress: 'Village Char Bhadrasan, Faridpur',
      countryCode: '+880',
      mobileNo: '1712345678',
      emailId: 'rakibul.hasan@example.com',
      facebookUrl: 'https://www.facebook.com/rakibul.hasan',
      linkedinUrl: 'https://www.linkedin.com/in/rakibulhasan',
      careerObjective:
        'To grow as a merchandising professional in a large export-oriented apparel group.',

      // 8 · Total years of experience (as the candidate states it)
      totalExperienceYears: 6.5,

      // 39–46 · Personal details
      fatherName: 'Md. Abdul Hasan',
      motherName: 'Mst. Rokeya Begum',
      Dob: '14/03/1994',
      gender: 'Male',
      MaritalStatus: 'Married',
      nationality: 'Bangladeshi',
      nationalId: '1994261234567',
      religion: 'Islam',
      BloodGroup: 'B+',
      heightMeters: 1.72,
      weightKg: 70,

      // 31–32 · Salary (either here or under careerInfo)
      currentSalary: 55000,
      expectedSalary: 70000,
    },

    // 9–14 · Employment history, one row per post
    EmploymentHistory: [
      {
        companyName: 'Ha-Meem Group',
        designation: 'Senior Merchandiser',
        companyLocation: 'Tejgaon, Dhaka',
        areaOfExpertise: 'Knit merchandising, costing',
        responsibilities:
          'Handled 4 European buyers end to end: costing, sampling, T&A and shipment.',
        fromDate: '01/02/2021',
        toDate: '',
      },
      {
        companyName: 'Epyllion Group',
        designation: 'Merchandiser',
        companyLocation: 'Gazipur',
        areaOfExpertise: 'Sampling and approvals',
        responsibilities: 'Sample development and lab-dip approvals for two buyers.',
        fromDate: '01/08/2018',
        toDate: '31/01/2021',
      },
    ],

    // 15–21 · Academic qualification
    qualifications: [
      {
        degree: 'MBA',
        concentration: 'Marketing',
        institute: 'University of Dhaka',
        result: '3.62',
        resultScale: '4',
        passYear: 2018,
        duration: '2 years',
        achievement: "Dean's list",
      },
      {
        degree: 'BSc in Textile Engineering',
        concentration: 'Apparel Manufacturing',
        institute: 'Bangladesh University of Textiles',
        result: '3.41',
        resultScale: '4',
        passYear: 2016,
        duration: '4 years',
      },
    ],

    // 22–25 · Training
    trainings: [
      {
        title: 'Advanced Garment Costing',
        topic: 'FOB costing, CM calculation',
        institute: 'BGMEA Institute of Fashion & Technology',
        country: 'Bangladesh',
        location: 'Dhaka',
        year: 2022,
        duration: '2 weeks',
      },
    ],

    // 26–28 · Professional qualifications (certifications)
    professionalQualifications: [
      {
        certification: 'Certified Merchandising Professional',
        institute: 'Textile Institute',
        location: 'Manchester, UK',
        fromDate: '01/01/2023',
        toDate: '30/06/2023',
      },
    ],

    // 29–34 · Career and application information
    careerInfo: {
      preferredJobCategories: ['Garments/Textile', 'Merchandising'],
      jobLevel: 'Mid',
      presentSalary: 55000,
      expectedSalary: 70000,
      preferredDistricts: ['Dhaka', 'Gazipur'],
      preferredOrganizationTypes: ['Garments', 'Textile'],
    },

    // 35–36 · Skills
    skills: [
      { name: 'Merchandising', description: 'Six years across knit and woven.' },
      { name: 'MS Excel', description: '' },
    ],

    // 37–38 · Languages
    languages: [
      { language: 'Bangla', reading: 'High', writing: 'High', speaking: 'High' },
      { language: 'English', reading: 'High', writing: 'Medium', speaking: 'Medium' },
    ],

    // 47–51 · References
    references: [
      {
        name: 'Md. Kamal Uddin',
        organization: 'Ha-Meem Group',
        designation: 'General Manager, Merchandising',
        relation: 'Professional',
        email: 'kamal.uddin@example.com',
        phone: '+880 1811000000',
      },
    ],
  },
};
